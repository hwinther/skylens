/**
 * Pure-TypeScript satellite propagation for the AR overlay's 4th (orbital) pass.
 *
 * The backend hands us verbatim CelesTrak OMM element sets (UPPERCASE keys, by design) that feed
 * satellite.js `json2satrec` straight into an SGP4 propagator. This module owns everything CPU-heavy
 * about satellites — building the propagators once per TLE payload and, on a 1 Hz cadence, running
 * SGP4 + the ECI→ECF→look-angle transforms to place each satellite as an azimuth/elevation the
 * projection layer can consume exactly like an aircraft's. SGP4 is FAR too heavy to run per rAF
 * frame, so the hook drives this at 1 Hz and the overlay only re-projects the precomputed az/el.
 *
 * Only the pure-JS satellite.js import path is used (json2satrec / propagate / gstime / the
 * transforms / dopplerFactor) — never the WASM bulk API. Must import nothing from
 * react-native / expo / react (see the src/ar/ eslint guard); satellite.js is allowed.
 */

import {
  dopplerFactor,
  ecfToLookAngles,
  eciToEcf,
  geodeticToEcf,
  gstime,
  json2satrec,
  propagate,
  SatRecError,
  type OMMJsonObject,
  type SatRec,
} from "satellite.js";
import type { SatelliteDto } from "@/api/types";
import { angleDiff, deg2rad, normalizeAzimuth, rad2deg } from "./geo";

/** The four normalised satellite groups the backend collapses CelesTrak's many lists into. */
export type SatGroup = "stations" | "amateur" | "weather" | "gnss";

/** Hard cap on rendered satellites per frame (highest-priority first). Bounds the overlay's work. */
export const SATELLITE_RENDER_CAP = 30;

/** Default elevation mask (deg): satellites below this above the horizon are hidden. */
export const DEFAULT_ELEVATION_MASK_DEG = 5;

/**
 * Render priority per group (lower = kept first when capping / decluttering). Crewed + amateur
 * stations you can actually work beat the dense, ever-present GNSS constellations.
 */
export const GROUP_PRIORITY: Record<SatGroup, number> = {
  stations: 0,
  amateur: 1,
  weather: 2,
  gnss: 3,
};

/** Speed of light in km/s (matches satellite.js's internal constant used by dopplerFactor). */
export const SPEED_OF_LIGHT_KM_S = 299792.458;

/**
 * Seconds ahead of the primary sample at which the second SGP4 evaluation is taken to finite-difference
 * the az/el angular rates. 1 s is fine at these angular speeds (a fast LEO overhead is ~1°/s) and keeps
 * the rate a clean per-second value. Doubling SGP4 (2 evals/sat/tick for ~333 sats) is trivial.
 */
export const RATE_SAMPLE_S = 1;

/**
 * Maximum sample age (s) the overlay is allowed to extrapolate a view. Clamps `extrapolateView` so a
 * stalled 1 Hz interval or a backgrounded tab (where Date.now() jumps well past the last sample) can't
 * fling a label far off its true track — after this the label simply holds a bounded lead.
 */
export const MAX_EXTRAPOLATION_S = 2;

/** Group priority for an arbitrary (possibly unknown) group string — unknown sorts last. */
function groupPriority(group: SatGroup): number {
  return GROUP_PRIORITY[group] ?? Number.MAX_SAFE_INTEGER;
}

/** Coerce the DTO's free-form group string into a SatGroup (unknown values pass through as-is). */
function toSatGroup(group: string): SatGroup {
  return group as SatGroup;
}

/** A built SGP4 propagator plus the identity we carry forward to each propagated view. */
export interface SatrecEntry {
  noradId: number;
  name: string;
  group: SatGroup;
  freqSummary?: string;
  satrec: SatRec;
}

/** A satellite reduced to observer-relative look angles at a single instant. */
export interface SatelliteView {
  noradId: number;
  name: string;
  group: SatGroup;
  /** Azimuth in degrees, 0 = North, clockwise, [0, 360). */
  azimuthDeg: number;
  /** Elevation in degrees above the local horizon, [-90, 90]. */
  elevationDeg: number;
  /**
   * Azimuth angular rate in degrees/second at the sample instant (finite-differenced over RATE_SAMPLE_S,
   * 0/360-wrap-safe via angleDiff). The overlay extrapolates az between 1 Hz ticks with this; 0 ⇒ steps.
   */
  azimuthRateDegS: number;
  /** Elevation angular rate in degrees/second at the sample instant. 0 ⇒ the view just steps (no fling). */
  elevationRateDegS: number;
  /** Slant range to the satellite in km. */
  rangeKm: number;
  /** Range rate in km/s; negative = approaching (Doppler shifts the downlink higher). */
  rangeRateKmS: number;
  freqSummary?: string;
}

/** Observer position for propagation: geodetic lat/lon (deg) + optional altitude (metres). */
export interface Observer {
  lat: number;
  lon: number;
  alt?: number;
}

/**
 * Build one SGP4 propagator from a single OMM element set, or null if it can't be propagated. Both a
 * corrupt OMM (json2satrec throws) and an unpropagatable one (json2satrec sets `error`) collapse to
 * null — one code path the batch `buildSatrecs` and the detail sheet's single-satellite pass math
 * (`nextPass`) both go through.
 */
export function buildSatrec(omm: SatelliteDto["omm"]): SatRec | null {
  try {
    // The OMM keys are UPPERCASE by design so this feeds json2satrec directly; our generated OMM
    // type marks every field optional (an NRT quirk), so cast to the library's stricter shape.
    const satrec = json2satrec(omm as unknown as OMMJsonObject);
    // json2satrec sets `error` on an unpropagatable element set instead of throwing — drop those.
    if (!satrec || satrec.error !== SatRecError.None) return null;
    return satrec;
  } catch {
    // Corrupt OMM (missing/garbage elements).
    return null;
  }
}

/**
 * Build one SGP4 propagator per satellite from its OMM elements. Failures (a corrupt / unpropagatable
 * OMM) are dropped rather than thrown — one bad element set never sinks the whole snapshot.
 */
export function buildSatrecs(sats: SatelliteDto[]): SatrecEntry[] {
  const entries: SatrecEntry[] = [];
  for (const sat of sats) {
    const satrec = buildSatrec(sat.omm);
    if (!satrec) continue;
    entries.push({
      noradId: sat.noradId,
      name: sat.name,
      group: toSatGroup(sat.group),
      ...(sat.freqSummary != null ? { freqSummary: sat.freqSummary } : {}),
      satrec,
    });
  }
  return entries;
}

/**
 * Propagate every entry to `date` and reduce it to observer-relative look angles. Entries whose SGP4
 * propagation errors or returns a non-finite position are dropped.
 */
export function propagateAll(
  entries: SatrecEntry[],
  observer: Observer,
  date: Date,
): SatelliteView[] {
  const observerGd = {
    longitude: deg2rad(observer.lon),
    latitude: deg2rad(observer.lat),
    height: (observer.alt ?? 0) / 1000, // metres → km
  };
  const observerEcf = geodeticToEcf(observerGd);
  const gmst = gstime(date);

  // Second sample RATE_SAMPLE_S ahead, used only to finite-difference the az/el angular rates the AR
  // overlay extrapolates between 1 Hz ticks. Its GMST is precomputed once (same instant for every sat).
  const date2 = new Date(date.getTime() + RATE_SAMPLE_S * 1000);
  const gmst2 = gstime(date2);

  const views: SatelliteView[] = [];
  for (const entry of entries) {
    const pv = propagate(entry.satrec, date);
    if (!pv || !pv.position || !pv.velocity) continue;
    const positionEci = pv.position;
    const velocityEci = pv.velocity;
    if (!Number.isFinite(positionEci.x) || !Number.isFinite(positionEci.y) || !Number.isFinite(positionEci.z)) {
      continue;
    }

    const positionEcf = eciToEcf(positionEci, gmst);
    const velocityEcf = eciToEcf(velocityEci, gmst);
    const look = ecfToLookAngles(observerGd, positionEcf);

    const azimuthDeg = normalizeAz(rad2deg(look.azimuth));
    const elevationDeg = rad2deg(look.elevation);
    const rangeKm = look.rangeSat;
    if (!Number.isFinite(azimuthDeg) || !Number.isFinite(elevationDeg) || !Number.isFinite(rangeKm)) {
      continue;
    }

    // Range rate via satellite.js's dopplerFactor (= 1 − rangeRate/c). It corrects the ECF velocity
    // for the observer's own earth-rotation motion — cleaner and more correct than a hand-rolled
    // line-of-sight dot — so back the signed range rate out of it. Negative ⇒ approaching.
    const rangeRateKmS = (1 - dopplerFactor(observerEcf, positionEcf, velocityEcf)) * SPEED_OF_LIGHT_KM_S;

    // Angular rates: propagate the SAME satrec RATE_SAMPLE_S ahead and finite-difference the look
    // angles. angleDiff carries the 0/360 azimuth seam (a satellite crossing north must NOT produce a
    // ±360°/s spike). Any error / non-finite in the second sample leaves the rates at 0 — that view
    // simply steps at 1 Hz like before, it never flings. The primary sample still governs inclusion.
    let azimuthRateDegS = 0;
    let elevationRateDegS = 0;
    const pv2 = propagate(entry.satrec, date2);
    if (
      pv2 &&
      pv2.position &&
      Number.isFinite(pv2.position.x) &&
      Number.isFinite(pv2.position.y) &&
      Number.isFinite(pv2.position.z)
    ) {
      const look2 = ecfToLookAngles(observerGd, eciToEcf(pv2.position, gmst2));
      const azimuthDeg2 = normalizeAzimuth(rad2deg(look2.azimuth));
      const elevationDeg2 = rad2deg(look2.elevation);
      if (Number.isFinite(azimuthDeg2) && Number.isFinite(elevationDeg2)) {
        azimuthRateDegS = angleDiff(azimuthDeg2, azimuthDeg) / RATE_SAMPLE_S;
        elevationRateDegS = (elevationDeg2 - elevationDeg) / RATE_SAMPLE_S;
      }
    }

    views.push({
      noradId: entry.noradId,
      name: entry.name,
      group: entry.group,
      azimuthDeg,
      elevationDeg,
      azimuthRateDegS,
      elevationRateDegS,
      rangeKm,
      rangeRateKmS: Number.isFinite(rangeRateKmS) ? rangeRateKmS : 0,
      ...(entry.freqSummary != null ? { freqSummary: entry.freqSummary } : {}),
    });
  }
  return views;
}

/**
 * Extrapolate a 1 Hz `SatelliteView` forward by `ageSeconds` using its carried az/el angular rates, so
 * the ~20 fps overlay glides a fast LEO satellite between propagation ticks instead of stepping once a
 * second. Linear: az = normalizeAzimuth(az + azRate·age), el = el + elRate·age. `ageSeconds` is clamped
 * to [0, MAX_EXTRAPOLATION_S] so a stalled interval / backgrounded tab can't fling the label. A view
 * with zero rates (a failed second sample) is returned essentially unchanged — it steps like before.
 */
export function extrapolateView(
  view: SatelliteView,
  ageSeconds: number,
): { azimuthDeg: number; elevationDeg: number } {
  const age = Math.min(MAX_EXTRAPOLATION_S, Math.max(0, ageSeconds));
  return {
    azimuthDeg: normalizeAzimuth(view.azimuthDeg + view.azimuthRateDegS * age),
    elevationDeg: view.elevationDeg + view.elevationRateDegS * age,
  };
}

/**
 * Filter to satellites above the mask AND in an enabled group, sort by (group priority asc, then
 * elevation desc — highest in the sky first within a group), and cap to SATELLITE_RENDER_CAP.
 */
export function selectVisible(
  views: SatelliteView[],
  maskDeg: number,
  enabledGroups: Set<SatGroup>,
): SatelliteView[] {
  const visible = views.filter((v) => v.elevationDeg >= maskDeg && enabledGroups.has(v.group));
  visible.sort((a, b) => {
    const pa = groupPriority(a.group);
    const pb = groupPriority(b.group);
    if (pa !== pb) return pa - pb;
    return b.elevationDeg - a.elevationDeg;
  });
  return visible.length > SATELLITE_RENDER_CAP ? visible.slice(0, SATELLITE_RENDER_CAP) : visible;
}

/**
 * Doppler-correct a downlink frequency (Hz) for a satellite's line-of-sight range rate (km/s):
 * f × (1 − rangeRate/c). Approaching (rangeRate < 0) ⇒ observed frequency is HIGHER. Exported for
 * the Phase 5 detail sheet's live-tuning readout.
 */
export function dopplerCorrectedHz(freqHz: number, rangeRateKmS: number): number {
  return freqHz * (1 - rangeRateKmS / SPEED_OF_LIGHT_KM_S);
}

/** The three group toggles the settings screen exposes (stations + amateur share one switch). */
export interface SatGroupToggles {
  /** Crewed "stations" + amateur satellites — the ones you can visually spot / work. */
  amateurStations: boolean;
  weather: boolean;
  gnss: boolean;
}

/**
 * Derive the enabled-group set from the three settings toggles. "stations" + "amateur" ride a single
 * toggle (both are things you can visually spot / work); weather and gnss are independent. Shared by
 * the AR screen and the List screen so the mapping lives in exactly one place.
 */
export function satGroupsFromSettings(toggles: SatGroupToggles): Set<SatGroup> {
  const groups = new Set<SatGroup>();
  if (toggles.amateurStations) {
    groups.add("stations");
    groups.add("amateur");
  }
  if (toggles.weather) groups.add("weather");
  if (toggles.gnss) groups.add("gnss");
  return groups;
}

/**
 * Format a frequency (Hz) as a MHz string at kHz precision (3 decimals): 145_800_000 → "145.800 MHz".
 * Both the nominal downlink and the live Doppler-corrected value flow through this so the detail sheet
 * shows one consistent format.
 */
export function formatFrequencyHz(freqHz: number): string {
  return `${(freqHz / 1_000_000).toFixed(3)} MHz`;
}

/** Normalise an azimuth (deg) to [0, 360). ecfToLookAngles already returns [0, 2π), so this is a guard. */
function normalizeAz(azDeg: number): number {
  let a = azDeg % 360;
  if (a < 0) a += 360;
  return a;
}

// ---------------------------------------------------------------------------
// Pass prediction (AOS / LOS / max elevation) for a single satellite.
//
// A "pass" is one arc where the satellite is above the elevation mask. We scan
// SGP4 forward in coarse steps to bracket the rise (AOS) and set (LOS) edges, then
// bisect each edge to ~1 s and golden-section the elevation peak to ~0.1°. All of
// this reuses the exact propagate → gstime → eciToEcf → ecfToLookAngles pipeline
// that `propagateAll` runs, so a pass agrees with the live 1 Hz look angles.
// ---------------------------------------------------------------------------

/** A predicted (or in-progress) pass of one satellite over the observer. */
export interface SatellitePass {
  /** Acquisition of signal — the satellite rises through the mask. Clamped to `fromDate` if already up. */
  aosTime: Date;
  /** Loss of signal — the satellite sets below the mask. Clamped to the horizon end for an always-up pass. */
  losTime: Date;
  /** Peak elevation reached during the pass, degrees above the horizon. */
  maxElevationDeg: number;
  /** Instant of peak elevation. */
  maxElevationTime: Date;
  /** Azimuth (deg, 0 = N clockwise) at the AOS instant — the rise bearing. */
  aosAzimuthDeg: number;
  /** Azimuth (deg, 0 = N clockwise) at the LOS instant — the set bearing. */
  losAzimuthDeg: number;
  /** True ⇒ the satellite was already above the mask at `fromDate` (AOS is clamped to now). */
  inProgress: boolean;
}

/** Observer position in the geodetic-radians shape satellite.js's look-angle transforms consume. */
interface ObserverGd {
  longitude: number;
  latitude: number;
  height: number;
}

/**
 * Propagate `satrec` to `date` and reduce to observer-relative azimuth/elevation (deg), or null if the
 * SGP4 step errors / returns a non-finite position — the same guards `propagateAll` applies per frame.
 */
function passLookAngles(satrec: SatRec, observerGd: ObserverGd, date: Date): { azimuthDeg: number; elevationDeg: number } | null {
  const pv = propagate(satrec, date);
  if (!pv || !pv.position) return null;
  const positionEci = pv.position;
  if (!Number.isFinite(positionEci.x) || !Number.isFinite(positionEci.y) || !Number.isFinite(positionEci.z)) {
    return null;
  }
  const gmst = gstime(date);
  const positionEcf = eciToEcf(positionEci, gmst);
  const look = ecfToLookAngles(observerGd, positionEcf);
  const azimuthDeg = normalizeAz(rad2deg(look.azimuth));
  const elevationDeg = rad2deg(look.elevation);
  if (!Number.isFinite(azimuthDeg) || !Number.isFinite(elevationDeg)) return null;
  return { azimuthDeg, elevationDeg };
}

/**
 * Bisect the mask crossing between two bracketing instants (elevations on opposite sides of `maskDeg`)
 * down to ~0.5 s. Works for both a rising and a falling edge — the direction is read off `loMs`.
 */
function bisectCrossing(loMs: number, hiMs: number, maskDeg: number, elevAt: (ms: number) => number | null): number {
  let a = loMs;
  let b = hiMs;
  const belowAtA = (elevAt(a) ?? maskDeg) < maskDeg;
  // 30 s bracket → 0.5 s takes ~6 halvings; cap the loop as a guard.
  for (let i = 0; i < 50 && b - a > 500; i++) {
    const mid = (a + b) / 2;
    const below = (elevAt(mid) ?? maskDeg) < maskDeg;
    if (below === belowAtA) a = mid;
    else b = mid;
  }
  return (a + b) / 2;
}

/**
 * Golden-section refine of the elevation peak within ±one step of the coarse maximum, clamped to the
 * [aos, los] arc. Elevation is unimodal over that small window, so this lands the peak to well under 0.1°.
 */
function refinePeak(
  centerMs: number,
  aosMs: number,
  losMs: number,
  stepMs: number,
  elevAt: (ms: number) => number | null,
): { timeMs: number; elevationDeg: number } {
  const f = (ms: number): number => elevAt(ms) ?? -Infinity;
  let a = Math.max(aosMs, centerMs - stepMs);
  let b = Math.min(losMs, centerMs + stepMs);
  const gr = (Math.sqrt(5) - 1) / 2; // 0.618…
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < 50 && b - a > 250; i++) {
    if (fc >= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - gr * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + gr * (b - a);
      fd = f(d);
    }
  }
  const timeMs = (a + b) / 2;
  return { timeMs, elevationDeg: f(timeMs) };
}

/**
 * Predict the next pass of `satrec` over `observer` at or after `fromDate`, using the elevation mask
 * `maskDeg`. Steps SGP4 forward in `stepSeconds` (default 30) increments up to `horizonHours` (default
 * 48), brackets the rise/set edges, then refines AOS/LOS by bisection and the peak by golden-section.
 *
 * Returns null when no rise occurs within the horizon. Three edge cases are handled explicitly:
 *  - Already above the mask at `fromDate` → `inProgress: true`, `aosTime = fromDate`, LOS found ahead.
 *  - No rise within the horizon → null.
 *  - Still up at the horizon end (a long/high MEO pass) → `losTime` is clamped to the horizon and the
 *    pass is returned rather than scanned forever.
 *
 * A few thousand SGP4 evaluations for one satellite over 48 h — a few ms; fine to run inline.
 */
export function nextPass(
  satrec: SatRec,
  observer: Observer,
  fromDate: Date,
  maskDeg: number,
  opts?: { stepSeconds?: number; horizonHours?: number },
): SatellitePass | null {
  const stepMs = (opts?.stepSeconds ?? 30) * 1000;
  const observerGd: ObserverGd = {
    longitude: deg2rad(observer.lon),
    latitude: deg2rad(observer.lat),
    height: (observer.alt ?? 0) / 1000, // metres → km
  };
  const elevAt = (ms: number): number | null => {
    const look = passLookAngles(satrec, observerGd, new Date(ms));
    return look ? look.elevationDeg : null;
  };

  const fromMs = fromDate.getTime();
  const horizonMs = fromMs + (opts?.horizonHours ?? 48) * 3_600_000;
  const startEl = elevAt(fromMs);

  // --- Locate AOS: already up, or the first rising edge ahead. ---
  let aosMs: number;
  let inProgress: boolean;
  if (startEl != null && startEl >= maskDeg) {
    aosMs = fromMs;
    inProgress = true;
  } else {
    let prevMs = fromMs;
    let prevEl = startEl;
    let rising: number | null = null;
    for (let ms = fromMs + stepMs; ms <= horizonMs; ms += stepMs) {
      const el = elevAt(ms);
      if (el != null && prevEl != null && prevEl < maskDeg && el >= maskDeg) {
        rising = bisectCrossing(prevMs, ms, maskDeg, elevAt);
        break;
      }
      prevMs = ms;
      prevEl = el;
    }
    if (rising == null) return null; // no pass within the horizon
    aosMs = rising;
    inProgress = false;
  }

  // --- From AOS, track the coarse peak and locate the falling edge (LOS). ---
  let maxEl = elevAt(aosMs) ?? maskDeg;
  let maxElMs = aosMs;
  let losMs: number | null = null;
  {
    let prevMs = aosMs;
    let prevEl = maxEl;
    for (let ms = aosMs + stepMs; ms <= horizonMs; ms += stepMs) {
      const el = elevAt(ms);
      if (el == null) {
        prevMs = ms;
        continue;
      }
      if (el > maxEl) {
        maxEl = el;
        maxElMs = ms;
      }
      if (prevEl != null && prevEl >= maskDeg && el < maskDeg) {
        losMs = bisectCrossing(prevMs, ms, maskDeg, elevAt);
        break;
      }
      prevMs = ms;
      prevEl = el;
    }
  }
  // Still above the mask at the window edge (e.g. a MEO GNSS sat): clamp LOS to the horizon.
  if (losMs == null) losMs = horizonMs;

  // --- Refine the peak locally to ~0.1°. ---
  const peak = refinePeak(maxElMs, aosMs, losMs, stepMs, elevAt);
  if (peak.elevationDeg > maxEl) {
    maxEl = peak.elevationDeg;
    maxElMs = peak.timeMs;
  }

  const aosLook = passLookAngles(satrec, observerGd, new Date(aosMs));
  const losLook = passLookAngles(satrec, observerGd, new Date(losMs));

  return {
    aosTime: new Date(aosMs),
    losTime: new Date(losMs),
    maxElevationDeg: maxEl,
    maxElevationTime: new Date(maxElMs),
    aosAzimuthDeg: aosLook?.azimuthDeg ?? 0,
    losAzimuthDeg: losLook?.azimuthDeg ?? 0,
    inProgress,
  };
}

/**
 * Format a pass length (milliseconds) as mm:ss, e.g. 532_000 → "08:52". Minutes are not capped at 59
 * (a clamped MEO arc can run long), seconds are two-digit. Pure display helper — kept here beside
 * `formatFrequencyHz` so the sheet's pass math and its formatting are both jest-testable.
 */
export function formatPassDuration(durationMs: number): string {
  const totalSec = Math.max(0, Math.round(durationMs / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/**
 * Format a forward time delta (milliseconds) as a coarse countdown: "in 2h 14m", "in 14m", "in 45s".
 * Non-positive deltas (the instant is now or past) render "now". Pure display helper.
 */
export function formatCountdown(deltaMs: number): string {
  if (deltaMs <= 0) return "now";
  const totalSec = Math.round(deltaMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `in ${h}h ${m}m`;
  if (m > 0) return `in ${m}m`;
  return `in ${s}s`;
}
