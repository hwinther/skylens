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
import { deg2rad, rad2deg } from "./geo";

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
 * Build one SGP4 propagator per satellite from its OMM elements. Failures (a corrupt / unpropagatable
 * OMM) are dropped rather than thrown — one bad element set never sinks the whole snapshot.
 */
export function buildSatrecs(sats: SatelliteDto[]): SatrecEntry[] {
  const entries: SatrecEntry[] = [];
  for (const sat of sats) {
    try {
      // The OMM keys are UPPERCASE by design so this feeds json2satrec directly; our generated OMM
      // type marks every field optional (an NRT quirk), so cast to the library's stricter shape.
      const satrec = json2satrec(sat.omm as unknown as OMMJsonObject);
      // json2satrec sets `error` on an unpropagatable element set instead of throwing — drop those.
      if (!satrec || satrec.error !== SatRecError.None) continue;
      entries.push({
        noradId: sat.noradId,
        name: sat.name,
        group: toSatGroup(sat.group),
        ...(sat.freqSummary != null ? { freqSummary: sat.freqSummary } : {}),
        satrec,
      });
    } catch {
      // Corrupt OMM (missing/garbage elements): skip it, keep the rest of the snapshot.
    }
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

    views.push({
      noradId: entry.noradId,
      name: entry.name,
      group: entry.group,
      azimuthDeg,
      elevationDeg,
      rangeKm,
      rangeRateKmS: Number.isFinite(rangeRateKmS) ? rangeRateKmS : 0,
      ...(entry.freqSummary != null ? { freqSummary: entry.freqSummary } : {}),
    });
  }
  return views;
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
