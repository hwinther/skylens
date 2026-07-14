/**
 * Naked-eye satellite-visibility fusion for the AR overlay's orbital pass.
 *
 * A satellite pass is naked-eye visible when three things hold at once: the satellite is SUNLIT (outside
 * Earth's shadow), the observer's sky is DARK (the Sun below civil twilight at the observer), and the
 * satellite is meaningfully above the horizon (the caller's elevation mask). This module fuses the two
 * halves the app already owns — satellite.js SGP4 positions (satellites.ts) and astronomy-engine's Sun
 * (planets.ts) — into those predicates, plus the pass-window and "right now" helpers the detail sheet
 * and the Overhead list consume.
 *
 * Like its src/ar/ neighbours it imports nothing from react-native / expo / react (see the eslint guard);
 * satellite.js and astronomy-engine are the only runtime deps, so jest exercises it on any platform. It
 * imports only TYPES from ./satellites, so there is no runtime import cycle (satellites.ts imports the
 * value helpers here for its per-tick visibility flag).
 */

import {
  Body,
  Equator,
  GeoVector,
  Horizon,
  Observer as AstroObserver,
  RotateVector,
  Rotation_EQJ_EQD,
} from "astronomy-engine";
import { ecfToLookAngles, eciToEcf, gstime, propagate, type SatRec } from "satellite.js";
import { deg2rad, rad2deg } from "./geo";
import type { Observer, SatellitePass } from "./satellites";

/** Sun-altitude threshold (deg) for a "dark enough to spot satellites" sky — the end of civil twilight. */
export const CIVIL_TWILIGHT_DEG = -6;

/** Earth's equatorial radius (km) — the radius of the cylindrical shadow the sunlit test clears against. */
export const EARTH_RADIUS_KM = 6378.137;

/** A 3-vector in an equatorial frame — an ECI position in km, or a unit direction such as the Sun's. */
export interface EquatorialVec {
  x: number;
  y: number;
  z: number;
}

/**
 * Geocentric unit vector toward the Sun in the equator-of-date frame — the SAME frame SGP4 propagates a
 * satellite into (TEME). We take astronomy-engine's geocentric apparent Sun vector (EQJ / J2000, AU) and
 * rotate it EQJ→EQD; TEME and the true equator-of-date agree to ~arcminutes, far tighter than a shadow
 * test needs. Only the direction matters for the shadow geometry, so the AU magnitude is normalised away.
 */
export function sunUnitVector(date: Date): EquatorialVec {
  const eqj = GeoVector(Body.Sun, date, true);
  const eqd = RotateVector(Rotation_EQJ_EQD(date), eqj);
  const len = Math.hypot(eqd.x, eqd.y, eqd.z);
  return { x: eqd.x / len, y: eqd.y / len, z: eqd.z / len };
}

/**
 * Cylindrical Earth-shadow test given a PRECOMPUTED Sun unit vector, so a batch caller computes the Sun
 * direction once and reuses it across many satellites. With s = r·sunHat (the satellite position's signed
 * projection onto the Sun direction):
 *  - s > 0  → the satellite is on the sunward side of Earth's centre → always sunlit.
 *  - s ≤ 0  → it is behind the Earth; sunlit only if its perpendicular distance from the anti-solar axis,
 *             |r − s·sunHat|, exceeds Earth's radius (it pokes out of the shadow cylinder).
 * A cylinder ignores the umbra's slight taper (the Sun is not a point source), but at LEO the cone-vs-
 * cylinder boundary differs by only a few seconds of pass time — negligible for a "look up now" cue.
 */
export function isSatSunlitFromSunHat(positionEciKm: EquatorialVec, sunHat: EquatorialVec): boolean {
  const s = positionEciKm.x * sunHat.x + positionEciKm.y * sunHat.y + positionEciKm.z * sunHat.z;
  if (s > 0) return true;
  const px = positionEciKm.x - s * sunHat.x;
  const py = positionEciKm.y - s * sunHat.y;
  const pz = positionEciKm.z - s * sunHat.z;
  return Math.hypot(px, py, pz) > EARTH_RADIUS_KM;
}

/** Convenience: is a satellite at `positionEciKm` sunlit at `date`? Computes the Sun direction for you. */
export function isSatSunlit(positionEciKm: EquatorialVec, date: Date): boolean {
  return isSatSunlitFromSunHat(positionEciKm, sunUnitVector(date));
}

/**
 * Is the observer's sky dark — the Sun below `thresholdDeg` (default civil twilight, −6°) at the
 * observer's location and instant? Uses the SAME apparent-of-date Equator→Horizon reduction planets.ts
 * runs for the Sun, so this agrees exactly with the Sun the sky pass draws.
 */
export function isObserverDark(
  observer: Observer,
  date: Date,
  thresholdDeg: number = CIVIL_TWILIGHT_DEG,
): boolean {
  const obs = new AstroObserver(observer.lat, observer.lon, observer.alt ?? 0);
  const eq = Equator(Body.Sun, date, obs, true, true);
  const hor = Horizon(date, obs, eq.ra, eq.dec, "normal");
  return hor.altitude < thresholdDeg;
}

/** The naked-eye-visible sub-window of a pass (both bounds null when no sampled instant qualifies). */
export interface PassVisibility {
  /** True when at least one sampled instant of the pass is naked-eye visible. */
  visible: boolean;
  /** First qualifying sample instant, or null when the pass is never visible. */
  visibleStart: Date | null;
  /** Last qualifying sample instant, or null when the pass is never visible. */
  visibleEnd: Date | null;
}

/**
 * Walk a predicted pass rise→set at `stepSeconds` (default 30) and find the sub-window where it is
 * naked-eye visible: at each sample the satellite must be above `elevationMaskDeg` (reusing the exact
 * propagate → gstime → eciToEcf → ecfToLookAngles path satellites.ts's pass math runs), sunlit, AND the
 * observer's sky dark. The first and last qualifying samples bound the window; if none qualify the pass
 * is not visible and both bounds are null (so start ≤ end always holds when present). The Sun/dark checks
 * are re-evaluated per sample (both drift only slowly over a pass) — fine here since this runs once per
 * detail-sheet open, off the render hot path.
 */
export function passVisibility(opts: {
  satrec: SatRec;
  observer: Observer;
  pass: SatellitePass;
  elevationMaskDeg: number;
  stepSeconds?: number;
}): PassVisibility {
  const { satrec, observer, pass, elevationMaskDeg, stepSeconds = 30 } = opts;
  const observerGd = {
    longitude: deg2rad(observer.lon),
    latitude: deg2rad(observer.lat),
    height: (observer.alt ?? 0) / 1000, // metres → km
  };
  const stepMs = Math.max(1000, stepSeconds * 1000);
  const startMs = pass.aosTime.getTime();
  const endMs = pass.losTime.getTime();

  let visibleStart: Date | null = null;
  let visibleEnd: Date | null = null;
  for (let ms = startMs; ms <= endMs; ms += stepMs) {
    const date = new Date(ms);
    const pv = propagate(satrec, date);
    if (!pv || !pv.position) continue;
    const eci = pv.position;
    if (!Number.isFinite(eci.x) || !Number.isFinite(eci.y) || !Number.isFinite(eci.z)) continue;
    const look = ecfToLookAngles(observerGd, eciToEcf(eci, gstime(date)));
    const elevationDeg = rad2deg(look.elevation);
    if (!Number.isFinite(elevationDeg) || elevationDeg < elevationMaskDeg) continue;
    if (!isSatSunlit(eci, date)) continue;
    if (!isObserverDark(observer, date)) continue;
    if (visibleStart == null) visibleStart = date;
    visibleEnd = date;
  }
  return { visible: visibleStart != null, visibleStart, visibleEnd };
}

/**
 * Is a satellite naked-eye visible RIGHT NOW: sunlit at `date` AND the observer's sky dark? The elevation
 * mask is deliberately NOT applied here — the Overhead list only ever calls this for a satellite already
 * above the mask (it wouldn't be a row otherwise), so re-masking would be redundant work. For the hot
 * 1 Hz path the list instead reuses SatelliteView.visibleNow (propagateAll computes it with a single Sun
 * position + dark check hoisted across all satellites); this standalone form is for one-off checks/tests.
 */
export function isVisibleNow(opts: { satrec: SatRec; observer: Observer; date: Date }): boolean {
  const { satrec, observer, date } = opts;
  const pv = propagate(satrec, date);
  if (!pv || !pv.position) return false;
  const eci = pv.position;
  if (!Number.isFinite(eci.x) || !Number.isFinite(eci.y) || !Number.isFinite(eci.z)) return false;
  return isSatSunlit(eci, date) && isObserverDark(observer, date);
}
