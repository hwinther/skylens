/**
 * Pure-TS "what am I looking at?" matching for the AR identify feature (long-press and viewfinder).
 *
 * There is no terrain model, so nothing here ray-marches a DEM. Instead, for a pointing direction
 * (azimuth + elevation angle) we look for the named landmark — peak or populated place — that best fits
 * that direction:
 *
 *  - Each candidate gets a bearing, a great-circle distance, and an *apparent elevation band*: the
 *    angles at which it can appear, from its base to its top, including the Earth's curvature and
 *    standard atmospheric refraction (effective radius R / (1 − k), k = 0.13). A peak spans the top
 *    `PEAK_BODY_FRACTION` of its height (point at the flank and it still counts); a place's ground height
 *    is unknown, so its band runs from its surveyed elevation (or sea level) up to `PLACE_TERRAIN_M`.
 *  - Anything beyond the sea-level horizon from the observer's height (the sum of both horizon
 *    distances) is dropped, as is anything beyond its kind's range.
 *  - The angular error is the azimuth miss (scaled by cos(elevation)) combined with the distance from
 *    the pointed elevation to the band (zero inside it). Only candidates within the tolerance cone match,
 *    which is what makes empty sky return nothing: every band tops out near the horizon.
 *  - A crude occlusion check: a nearer peak at nearly the same bearing whose summit appears at least as
 *    high hides a farther candidate.
 *  - Among the rest, the best score wins: smaller angular error, then nearer and more significant
 *    (peak isolation and height; place class and population).
 *
 * This finds the nearest *named* feature in a direction. It cannot know what a ridge hides beyond the
 * crude check above, and GeoNames elevations are often the SRTM cell average, so the UI says so.
 *
 * Work is split for the per-move budget: `prepareLandmarks` does the trig for one observer (when the
 * observer or the data changes), `identifyAt` only compares angles, so the viewfinder can run it several
 * times a second against a few thousand candidates.
 *
 * Must import nothing from react-native / expo / react.
 */

import { angleDiff, deg2rad, EARTH_RADIUS_M, normalizeAzimuth, rad2deg } from "./geo";

export type LandmarkKind = "peak" | "city" | "town" | "village" | "hamlet";

/** Structural twin of the API's LandmarkDto (kept here so src/ar stays free of app imports). */
export interface Landmark {
  id: string;
  kind: LandmarkKind;
  name: string;
  lat: number;
  lon: number;
  elevationM?: number | null;
  population?: number | null;
  isolationKm?: number | null;
}

export interface IdentifyObserver {
  lat: number;
  lon: number;
  /** Eye height above sea level, metres (GPS altitude; 0 when unknown). */
  alt: number;
}

export interface IdentifyRay {
  /** Degrees true, [0, 360). */
  azimuth: number;
  /** Degrees above the horizontal. */
  elevation: number;
}

/** Standard terrestrial refraction coefficient (the surveyors' k ≈ 0.13). */
export const REFRACTION_K = 0.13;
/** Earth radius bent by refraction: light curves with the Earth, so the horizon sits a little further. */
export const EFFECTIVE_EARTH_RADIUS_M = EARTH_RADIUS_M / (1 - REFRACTION_K);

/** How far away each kind can be identified. Peaks match the fetch radius; places shrink with size. */
export const MAX_RANGE_KM: Record<LandmarkKind, number> = {
  peak: 150,
  city: 80,
  town: 50,
  village: 25,
  hamlet: 12,
};

/** Tolerance cone for a fingertip (≈ 40 dp is ≈ 6° across at the default 66° FOV; half of that, rounded up). */
export const FINGER_TOLERANCE_DEG = 4;
/** Tolerance cone for the viewfinder reticle, which is aimed deliberately. */
export const RETICLE_TOLERANCE_DEG = 2.5;

/** A peak counts from this fraction of its height (above sea level) up to its summit. */
export const PEAK_BODY_FRACTION = 0.6;
/** A place's ground height is unknown: assume it lies somewhere between sea level and this. */
export const PLACE_TERRAIN_M = 600;
/** Margin above a place's surveyed elevation (buildings, a sloping town). */
export const PLACE_KNOWN_SLACK_M = 50;
/** Closer than this you are standing in / on it; it is not "over there". */
export const MIN_DISTANCE_KM: Record<"peak" | "place", number> = { peak: 0.3, place: 1.5 };
/** A nearer peak this close in bearing whose summit appears at least as high hides a farther candidate. */
export const OCCLUSION_AZ_DEG = 1;

/** Score weights: angular error (as a fraction of the cone), distance (fraction of the kind's range), significance. */
export const SCORE_WEIGHTS = { error: 1, distance: 0.35, significance: 0.4 } as const;

/** Geocentric great-circle distance (m) and initial bearing (deg true) from a to b. */
export function distanceAndBearing(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): { distanceM: number; bearingDeg: number } {
  const p1 = deg2rad(a.lat);
  const p2 = deg2rad(b.lat);
  const dp = p2 - p1;
  const dl = deg2rad(b.lon - a.lon);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const distanceM = 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return { distanceM, bearingDeg: normalizeAzimuth(rad2deg(Math.atan2(y, x))) };
}

/**
 * Apparent elevation angle (deg) of a point `targetAltM` high at ground distance `distanceM`, seen from
 * `observerAltM`, with the curvature drop over the refraction-bent Earth: d² / (2·R′).
 */
export function apparentElevationDeg(observerAltM: number, targetAltM: number, distanceM: number): number {
  const d = Math.max(distanceM, 1);
  const drop = (d * d) / (2 * EFFECTIVE_EARTH_RADIUS_M);
  return rad2deg(Math.atan2(targetAltM - observerAltM - drop, d));
}

/** Distance (m) to the sea-level horizon from `heightM` up (refraction included). */
export function horizonDistanceM(heightM: number): number {
  return Math.sqrt(2 * EFFECTIVE_EARTH_RADIUS_M * Math.max(heightM, 0));
}

/** True when a point `targetAltM` high could rise above the sea-level horizon at that distance. */
export function aboveHorizon(observerAltM: number, targetAltM: number, distanceM: number): boolean {
  return distanceM <= horizonDistanceM(observerAltM) + horizonDistanceM(targetAltM);
}

const PLACE_CLASS: Record<Exclude<LandmarkKind, "peak">, number> = {
  city: 1,
  town: 0.7,
  village: 0.4,
  hamlet: 0.2,
};

/**
 * Significance in [0, 1]. Peaks: isolation (log-scaled; 100 km → 1) weighted over height (2 500 m → 1).
 * Places: class, nudged by population (log-scaled; 1 M → +0.2), capped at 1.
 */
export function significance(l: Landmark): number {
  if (l.kind === "peak") {
    const iso = Math.min(Math.log10((l.isolationKm ?? 0) + 1) / 2, 1);
    const ele = Math.min(Math.max(l.elevationM ?? 0, 0) / 2500, 1);
    return 0.6 * iso + 0.4 * ele;
  }
  const pop = l.population && l.population > 0 ? Math.min(Math.log10(l.population) / 6, 1) * 0.2 : 0;
  return Math.min(PLACE_CLASS[l.kind] + pop, 1);
}

/** One landmark reduced to angles for a fixed observer (see `prepareLandmarks`). */
export interface PreparedLandmark {
  landmark: Landmark;
  azimuthDeg: number;
  distanceKm: number;
  /** Lowest / highest apparent elevation (deg) at which it can appear. */
  bandLowDeg: number;
  bandHighDeg: number;
  significance: number;
}

/**
 * The per-observer half of the work: bearings, distances, elevation bands, and the range / horizon
 * filters. Recompute when the observer moves or the landmark set changes, not per frame.
 */
export function prepareLandmarks(
  observer: IdentifyObserver,
  landmarks: readonly Landmark[],
): PreparedLandmark[] {
  const obsAlt = Math.max(observer.alt, 0);
  const out: PreparedLandmark[] = [];
  for (const l of landmarks) {
    const range = MAX_RANGE_KM[l.kind];
    if (range == null) continue;
    const { distanceM, bearingDeg } = distanceAndBearing(observer, l);
    const distanceKm = distanceM / 1000;
    const isPeak = l.kind === "peak";
    if (distanceKm > range || distanceKm < MIN_DISTANCE_KM[isPeak ? "peak" : "place"]) continue;

    let lowAlt: number;
    let highAlt: number;
    if (isPeak) {
      if (l.elevationM == null) continue;
      highAlt = l.elevationM;
      lowAlt = l.elevationM * PEAK_BODY_FRACTION;
    } else if (l.elevationM != null) {
      lowAlt = l.elevationM;
      highAlt = l.elevationM + PLACE_KNOWN_SLACK_M;
    } else {
      lowAlt = 0;
      highAlt = PLACE_TERRAIN_M;
    }
    if (!aboveHorizon(obsAlt, highAlt, distanceM)) continue;

    out.push({
      landmark: l,
      azimuthDeg: bearingDeg,
      distanceKm,
      bandLowDeg: apparentElevationDeg(obsAlt, lowAlt, distanceM),
      bandHighDeg: apparentElevationDeg(obsAlt, highAlt, distanceM),
      significance: significance(l),
    });
  }
  return out;
}

export interface IdentifyMatch {
  landmark: Landmark;
  distanceKm: number;
  /** Where to put the marker: the landmark's bearing, and the pointed elevation clamped into its band. */
  azimuthDeg: number;
  elevationDeg: number;
  /** Angular miss from the pointed direction, degrees. */
  errorDeg: number;
  /** Lower is better. */
  score: number;
}

export interface IdentifyResult {
  best: IdentifyMatch;
  /** Runner-ups in score order (at most `maxAlternatives`), for an honest "also in that direction". */
  alternatives: IdentifyMatch[];
}

export interface IdentifyOptions {
  toleranceDeg?: number;
  maxAlternatives?: number;
}

/**
 * The per-move half: the best landmark in the tolerance cone around `ray`, or null when the direction
 * holds nothing named (empty sky, open sea, or nothing loaded).
 */
export function identifyAt(
  prepared: readonly PreparedLandmark[],
  ray: IdentifyRay,
  options: IdentifyOptions = {},
): IdentifyResult | null {
  const tol = options.toleranceDeg ?? FINGER_TOLERANCE_DEG;
  const maxAlt = options.maxAlternatives ?? 2;
  const cosEl = Math.max(Math.cos(deg2rad(ray.elevation)), 0.05);
  const window = tol / cosEl + OCCLUSION_AZ_DEG;

  // Peaks near the bearing, for the occlusion test; candidates inside the cone.
  const blockers: PreparedLandmark[] = [];
  const matches: (IdentifyMatch & { topDeg: number })[] = [];
  for (const p of prepared) {
    const dAz = angleDiff(p.azimuthDeg, ray.azimuth);
    if (Math.abs(dAz) > window) continue;
    if (p.landmark.kind === "peak") blockers.push(p);

    const azErr = Math.abs(dAz) * cosEl;
    const elErr =
      ray.elevation > p.bandHighDeg
        ? ray.elevation - p.bandHighDeg
        : ray.elevation < p.bandLowDeg
          ? p.bandLowDeg - ray.elevation
          : 0;
    const errorDeg = Math.hypot(azErr, elErr);
    if (errorDeg > tol) continue;

    const range = MAX_RANGE_KM[p.landmark.kind];
    const score =
      SCORE_WEIGHTS.error * (errorDeg / tol) +
      SCORE_WEIGHTS.distance * (p.distanceKm / range) -
      SCORE_WEIGHTS.significance * p.significance;
    matches.push({
      landmark: p.landmark,
      distanceKm: p.distanceKm,
      azimuthDeg: p.azimuthDeg,
      elevationDeg: Math.min(Math.max(ray.elevation, p.bandLowDeg), p.bandHighDeg),
      errorDeg,
      score,
      topDeg: p.bandHighDeg,
    });
  }
  if (matches.length === 0) return null;

  const visible = matches.filter(
    (m) =>
      !blockers.some(
        (b) =>
          b.landmark.id !== m.landmark.id &&
          b.distanceKm < m.distanceKm &&
          Math.abs(angleDiff(b.azimuthDeg, m.azimuthDeg)) <= OCCLUSION_AZ_DEG &&
          b.bandHighDeg >= m.topDeg,
      ),
  );
  if (visible.length === 0) return null;

  visible.sort((a, b) => a.score - b.score || a.distanceKm - b.distanceKm);
  const strip = ({ topDeg: _topDeg, ...m }: IdentifyMatch & { topDeg: number }): IdentifyMatch => m;
  return { best: strip(visible[0]), alternatives: visible.slice(1, 1 + maxAlt).map(strip) };
}

/** One-shot convenience: prepare + identify (tests, or a single long-press with no cached preparation). */
export function identifyLandmark(
  observer: IdentifyObserver,
  ray: IdentifyRay,
  landmarks: readonly Landmark[],
  options?: IdentifyOptions,
): IdentifyResult | null {
  return identifyAt(prepareLandmarks(observer, landmarks), ray, options);
}

// --- Fetch policy -------------------------------------------------------------------------------------

/** Radius of each landmarks fetch around the observer: the peak range. */
export const LANDMARK_FETCH_RADIUS_KM = MAX_RANGE_KM.peak;
/** Refetch once the observer has moved this far from the last fetch centre. */
export const LANDMARK_REFETCH_KM = 10;

/** True when there is no fetch yet, or the observer has moved `LANDMARK_REFETCH_KM` from its centre. */
export function shouldRefetchLandmarks(
  lastCentre: { lat: number; lon: number } | null,
  observer: { lat: number; lon: number },
): boolean {
  if (!lastCentre) return true;
  return distanceAndBearing(lastCentre, observer).distanceM / 1000 >= LANDMARK_REFETCH_KM;
}
