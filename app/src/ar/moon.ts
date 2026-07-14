/**
 * Pure-TypeScript Earth-Moon-Earth (EME / "moonbounce") facts for the Moon's detail sheet.
 *
 * Hams bounce VHF/UHF/microwave signals off the Moon and listen for their own echo. What matters to
 * them is a function of the Moon's geometry alone — no observer, no network: the round-trip echo delay
 * (2 · distance / c, ~2.4–2.7 s), the extra free-space path loss when the Moon is farther than this
 * month's closest pass (loss ∝ distance², so the level swings ~2 dB between perigee and apogee), and
 * the optical libration that makes the echo fade as the Moon slowly rocks. astronomy-engine supplies
 * all of it (geocentric distance + libration from `Libration`, the month's apsides from the lunar-apsis
 * search), so — like planets.ts — this stays a pure deterministic function of the passed `date` and
 * imports nothing from react-native / expo / react (see the src/ar/ eslint guard).
 */

import { ApsisKind, Libration, MakeTime, NextLunarApsis, SearchLunarApsis } from "astronomy-engine";

/** Speed of light in km/s — the echo-delay and (implicitly) path-loss constant. */
export const SPEED_OF_LIGHT_KM_S = 299792.458;

/** Mean Earth-Moon distance (km), for context only; the swing is taken from the computed apsides. */
export const MEAN_MOON_DISTANCE_KM = 385000;

/** The Moon reduced to the numbers an EME operator plans around, at a single instant. */
export interface MoonEmeInfo {
  /** Geocentric Earth-Moon centre-to-centre distance in km (`Libration.dist_km`). */
  distanceKm: number;
  /** Round-trip echo delay in seconds: `2 · distanceKm / c` (~2.4–2.7 s). */
  echoDelaySeconds: number;
  /** Optical libration in ecliptic latitude, degrees (`Libration.elat`). */
  librationLatDeg: number;
  /** Optical libration in ecliptic longitude, degrees (`Libration.elon`). */
  librationLonDeg: number;
  /** Apparent angular diameter of the Moon, degrees (`Libration.diam_deg`). */
  angularDiameterDeg: number;
  /** The next perigee (closest approach) from `date`: its instant + distance in km. */
  nextPerigee: { date: Date; km: number };
  /** The next apogee (farthest point) from `date`: its instant + distance in km. */
  nextApogee: { date: Date; km: number };
  /**
   * Extra ONE-WAY free-space path loss (dB) at the current distance relative to the closest perigee
   * (the best case): `20 · log10(distanceKm / perigeeKm)`. Free-space loss ∝ distance², so the ratio's
   * 20·log10 is frequency-independent (no band needed) — a small non-negative dB the operator adds
   * versus the closest Moon. One-way is the conventional figure to quote; a round trip would be ×2.
   * Floored at 0: in the ~1–2 days just after a perigee the Moon is nearer than the *next* perigee
   * (which is a month out), so the raw ratio dips slightly below 1 — that window is simply best-case.
   */
  pathLossPenaltyDb: number;
}

/**
 * Compute the EME facts for the Moon at `date` (geocentric — no observer). `Libration` gives the
 * distance, libration angles and angular diameter in one call; the next perigee and apogee come from
 * `SearchLunarApsis` (the next apsis after `date`) followed by one `NextLunarApsis` — lunar apsides
 * strictly alternate perigee/apogee, so those two calls always yield exactly one of each, both after
 * `date`. Pure + deterministic: pass a fixed `date` and the result is fixed.
 */
export function moonEmeInfo(date: Date): MoonEmeInfo {
  const time = MakeTime(date);
  const lib = Libration(time);
  const distanceKm = lib.dist_km;

  // Two consecutive apsides after `date` are always opposite kinds (perigee ↔ apogee), so pick each.
  const a1 = SearchLunarApsis(date);
  const a2 = NextLunarApsis(a1);
  const perigeeApsis = a1.kind === ApsisKind.Pericenter ? a1 : a2;
  const apogeeApsis = a1.kind === ApsisKind.Apocenter ? a1 : a2;

  const nextPerigee = { date: perigeeApsis.time.date, km: perigeeApsis.dist_km };
  const nextApogee = { date: apogeeApsis.time.date, km: apogeeApsis.dist_km };

  return {
    distanceKm,
    echoDelaySeconds: (2 * distanceKm) / SPEED_OF_LIGHT_KM_S,
    librationLatDeg: lib.elat,
    librationLonDeg: lib.elon,
    angularDiameterDeg: lib.diam_deg,
    nextPerigee,
    nextApogee,
    // Floor at 0: just after a perigee the Moon is closer than the *next* perigee → raw dips <0.
    pathLossPenaltyDb: Math.max(0, 20 * Math.log10(distanceKm / nextPerigee.km)),
  };
}
