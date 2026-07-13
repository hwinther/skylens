/**
 * Pure-TypeScript Solar-System body ephemeris for the AR overlay's 5th (sky) pass.
 *
 * Unlike aircraft / ships / satellites, planets need NO backend, NO MQTT and NO element sets: the Sun,
 * Moon and the seven other classical planets are a deterministic function of the observer's location
 * and the instant, computed entirely on-device with `astronomy-engine` (pure JS, sub-millisecond for
 * nine bodies). This module owns that math — reducing each body to an observer-relative azimuth /
 * elevation the projection layer consumes exactly like a satellite's, plus the magnitude / phase /
 * distance / constellation the list and detail sheet show, the rise/set/culmination "tonight" events,
 * and the faint ecliptic arc drawn across the sky.
 *
 * astronomy-engine is a pure-JS library (no WASM, no data files), so — like satellite.js — it is an
 * allowed import here even though this file must import nothing from react-native / expo / react (see
 * the src/ar/ eslint guard) so jest can exercise it on any platform.
 */

import {
  Body,
  Constellation,
  Equator,
  EquatorFromVector,
  Horizon,
  Illumination,
  Observer,
  RotateVector,
  Rotation_ECT_EQD,
  SearchHourAngle,
  SearchRiseSet,
  Spherical,
  VectorFromSphere,
} from "astronomy-engine";
import { normalizeAzimuth } from "./geo";

/**
 * Elevation mask (deg) for the sky pass: bodies below this above the horizon are hidden. Kept at 0 so
 * a planet just clearing the horizon still shows (astronomy-engine's "normal" refraction already lifts
 * a body sitting on the true horizon to a slightly positive apparent altitude).
 */
export const PLANET_ELEVATION_MASK_DEG = 0;

/**
 * The Sun's mean apparent visual magnitude. `Illumination` is meant for reflected-light bodies and the
 * Sun's brightness is effectively constant, so we pin it rather than derive it — it feeds the label's
 * mag readout and the magnitude→dot-size scale (the Sun always maps to the largest dot).
 */
export const SUN_MAGNITUDE = -26.7;

/** Observer position for the ephemeris: geodetic lat/lon (deg) + optional altitude (metres). */
export interface PlanetObserver {
  lat: number;
  lon: number;
  alt?: number;
}

/** A Solar-System body reduced to observer-relative look angles + display facts at a single instant. */
export interface PlanetView {
  /** Stable key AND display name — the astronomy-engine Body enum value, e.g. "Mars". */
  body: string;
  /** Display name (same as `body` for the classical set). */
  name: string;
  /** Azimuth in degrees, 0 = North, clockwise, [0, 360). */
  azimuthDeg: number;
  /** Apparent elevation in degrees above the horizon (refraction-corrected), [-90, 90]. */
  elevationDeg: number;
  /** Visual magnitude (lower = brighter); null when not meaningful. Sun is pinned to SUN_MAGNITUDE. */
  magnitude: number | null;
  /** Illuminated fraction as a percentage [0, 100]; null for the Sun (no phase in the usual sense). */
  phasePercent: number | null;
  /** Topocentric distance in astronomical units; null when the reduction is non-finite. */
  distanceAu: number | null;
  /** Name of the constellation the body sits in (J2000), e.g. "Taurus"; null when unavailable. */
  constellation: string | null;
}

/** One sampled point on the ecliptic arc, as observer-relative look angles. */
export interface EclipticPoint {
  /** Azimuth in degrees, 0 = North, clockwise, [0, 360). */
  azimuthDeg: number;
  /** Apparent elevation in degrees above the horizon. */
  elevationDeg: number;
}

/** The next rise / set / culmination "tonight" for one body, from the detail sheet's perspective. */
export interface PlanetEvents {
  /** Next time the body rises above the horizon, or null if it never rises within the search window. */
  rise: Date | null;
  /** Next time the body sets below the horizon, or null if it never sets (circumpolar) within the window. */
  set: Date | null;
  /** Next meridian transit (highest point); always found at non-polar latitudes within a day. */
  culmination: Date | null;
  /** Apparent altitude (deg) at that culmination — negative means it culminates below the horizon. */
  culminationAltitude: number | null;
}

/**
 * The nine bodies we track, in a fixed sky-familiar order (luminaries first, then outward). The enum
 * value doubles as the stable key and display name.
 */
export const PLANET_BODIES: { body: Body; name: string }[] = [
  { body: Body.Sun, name: "Sun" },
  { body: Body.Moon, name: "Moon" },
  { body: Body.Mercury, name: "Mercury" },
  { body: Body.Venus, name: "Venus" },
  { body: Body.Mars, name: "Mars" },
  { body: Body.Jupiter, name: "Jupiter" },
  { body: Body.Saturn, name: "Saturn" },
  { body: Body.Uranus, name: "Uranus" },
  { body: Body.Neptune, name: "Neptune" },
];

/** Look up an astronomy-engine Body by its stable key (the enum value), or null if unknown. */
export function bodyForKey(key: string): Body | null {
  const entry = PLANET_BODIES.find((b) => b.name === key);
  return entry ? entry.body : null;
}

/** Build the astronomy-engine Observer from our lat/lon/alt shape (alt defaults to sea level). */
function toObserver(observer: PlanetObserver): Observer {
  return new Observer(observer.lat, observer.lon, observer.alt ?? 0);
}

/**
 * Compute look angles + display facts for every tracked body at `date` as seen from `observer`, and
 * return only those at or above PLANET_ELEVATION_MASK_DEG (above the horizon). For each body:
 *  - `Equator(body, date, observer, ofdate=true, aberration=true)` → apparent RA/Dec of date, fed to
 *    `Horizon(..., "normal")` for refraction-corrected azimuth/altitude (the same one-path reduction
 *    the ecliptic arc uses, so the Sun lands exactly on the arc).
 *  - a second `Equator(..., ofdate=false, ...)` gives J2000 RA/Dec for `Constellation` (which is
 *    documented to expect J2000 input).
 *  - `Illumination` supplies visual magnitude + illuminated fraction for every body except the Sun,
 *    whose magnitude is pinned (SUN_MAGNITUDE) and phase left null.
 *  - the of-date Equator's `dist` is the topocentric distance in AU (works for the Sun too).
 */
export function computePlanets(observer: PlanetObserver, date: Date): PlanetView[] {
  const obs = toObserver(observer);
  const views: PlanetView[] = [];
  for (const { body, name } of PLANET_BODIES) {
    const eq = Equator(body, date, obs, true, true);
    const hor = Horizon(date, obs, eq.ra, eq.dec, "normal");
    if (!Number.isFinite(hor.altitude) || hor.altitude < PLANET_ELEVATION_MASK_DEG) continue;

    const eqJ2000 = Equator(body, date, obs, false, true);
    let constellation: string | null = null;
    try {
      constellation = Constellation(eqJ2000.ra, eqJ2000.dec).name || null;
    } catch {
      constellation = null;
    }

    let magnitude: number | null;
    let phasePercent: number | null;
    if (body === Body.Sun) {
      magnitude = SUN_MAGNITUDE;
      phasePercent = null;
    } else {
      const illum = Illumination(body, date);
      magnitude = Number.isFinite(illum.mag) ? illum.mag : null;
      phasePercent = Number.isFinite(illum.phase_fraction) ? illum.phase_fraction * 100 : null;
    }

    views.push({
      body: name,
      name,
      azimuthDeg: normalizeAzimuth(hor.azimuth),
      elevationDeg: hor.altitude,
      magnitude,
      phasePercent,
      distanceAu: Number.isFinite(eq.dist) ? eq.dist : null,
      constellation,
    });
  }
  return views;
}

/**
 * Predict the next rise, set and culmination of `body` over `observer` at or after `fromDate`, searching
 * up to `limitDays` (default 1 — "tonight"). Rise/set use `SearchRiseSet` (+1 rise, −1 set) and are null
 * for a body that never crosses the horizon in the window (a circumpolar body never sets; a body that
 * never clears the horizon never rises). Culmination uses `SearchHourAngle(body, observer, 0, fromDate)`
 * — a meridian transit occurs daily at any non-polar latitude, so it is essentially always found, and
 * its altitude tells you whether the body actually clears the horizon at its best. Pure and deterministic.
 */
export function nextPlanetEvents(
  body: Body,
  observer: PlanetObserver,
  fromDate: Date,
  limitDays = 1,
): PlanetEvents {
  const obs = toObserver(observer);
  const rise = SearchRiseSet(body, obs, +1, fromDate, limitDays);
  const set = SearchRiseSet(body, obs, -1, fromDate, limitDays);
  let culmination: Date | null = null;
  let culminationAltitude: number | null = null;
  try {
    const culm = SearchHourAngle(body, obs, 0, fromDate);
    culmination = culm.time.date;
    culminationAltitude = culm.hor.altitude;
  } catch {
    // A body that never transits the meridian in the window (polar edge cases) → leave nulls.
    culmination = null;
    culminationAltitude = null;
  }
  return {
    rise: rise ? rise.date : null,
    set: set ? set.date : null,
    culmination,
    culminationAltitude,
  };
}

/**
 * Sample the ecliptic (the Sun's apparent yearly path, and the plane the planets hug) as a series of
 * observer-relative look angles, for the faint arc drawn across the AR sky. Ecliptic longitude is
 * stepped `stepDeg` (default 5°) at ecliptic latitude 0, each point rotated ecliptic-of-date → equatorial
 * -of-date (`Rotation_ECT_EQD`) then run through the SAME `Horizon(..., "normal")` reduction planets use,
 * so an up Sun lands right on the arc. Only points at or above −5° elevation are kept (the arc fades out
 * below the horizon rather than wrapping underground).
 */
export function eclipticLinePoints(
  observer: PlanetObserver,
  date: Date,
  stepDeg = 5,
): EclipticPoint[] {
  const obs = toObserver(observer);
  const rot = Rotation_ECT_EQD(date);
  const points: EclipticPoint[] = [];
  const step = stepDeg > 0 ? stepDeg : 5;
  for (let elon = 0; elon < 360; elon += step) {
    const eclVec = VectorFromSphere(new Spherical(0, elon, 1), date);
    const eq = EquatorFromVector(RotateVector(rot, eclVec));
    const hor = Horizon(date, obs, eq.ra, eq.dec, "normal");
    if (!Number.isFinite(hor.altitude) || hor.altitude <= -5) continue;
    points.push({ azimuthDeg: normalizeAzimuth(hor.azimuth), elevationDeg: hor.altitude });
  }
  return points;
}

/** Smallest / largest planet-dot diameter (px) the magnitude scale maps to. */
export const MIN_PLANET_DOT = 6;
export const MAX_PLANET_DOT = 16;

/**
 * Map a visual magnitude to a dot diameter (px): brighter (more negative) → larger, clamped to
 * [MIN_PLANET_DOT, MAX_PLANET_DOT]. The Sun/Moon (very bright) peg the max; a faint outer planet like
 * Neptune (mag ~+8) floors at the min. A null magnitude falls back to a mid size. Pure + testable.
 */
export function planetDotSize(magnitude: number | null): number {
  if (magnitude == null || !Number.isFinite(magnitude)) {
    return Math.round((MIN_PLANET_DOT + MAX_PLANET_DOT) / 2);
  }
  const size = Math.round(11 - magnitude * 1.1);
  return Math.max(MIN_PLANET_DOT, Math.min(MAX_PLANET_DOT, size));
}
