/**
 * Orbit class (LEO / MEO / GEO / IGSO / HEO) plus period and apogee/perigee altitudes from a satellite's OMM
 * mean elements, for the satellite detail sheet and the simulator HUD. Pure TS, no react imports.
 *
 * The altitudes come from the mean motion via Kepler's third law (a = (mu / n^2)^(1/3)) and the
 * eccentricity, over a spherical Earth of mean radius: mean-element approximations, good to a few km,
 * which is plenty for a label.
 */

import type { SatelliteOmm } from "@/api/types";
import { EARTH_RADIUS_M } from "./geo";

export type OrbitClass = "LEO" | "MEO" | "GEO" | "IGSO" | "HEO";

export interface OrbitInfo {
  class: OrbitClass;
  /** Orbital period, minutes. */
  periodMin: number;
  /** Highest / lowest altitude above the mean Earth radius, km. */
  apogeeKm: number;
  perigeeKm: number;
}

/** Earth's gravitational parameter, km^3/s^2. */
export const MU_EARTH_KM3_S2 = 398600.4418;

const EARTH_RADIUS_KM = EARTH_RADIUS_M / 1000;

/** Above this eccentricity an orbit is highly elliptical (Molniya ~0.72, Tundra ~0.27). */
export const HEO_MIN_ECCENTRICITY = 0.25;
/** Geosynchronous: about one revolution per sidereal day. */
export const GEO_MIN_MEAN_MOTION = 0.99;
export const GEO_MAX_MEAN_MOTION = 1.01;
/** Drifting/retired geostationary satellites wander up to ~15°; BeiDou IGSO (~55°) and QZSS (~40°) sit well above. */
export const IGSO_MIN_INCLINATION_DEG = 20;
/** LEO: a period under 128 minutes, i.e. more than 11.25 revolutions per day. */
export const LEO_MIN_MEAN_MOTION = 1440 / 128;

/** Plain-language names for the acronyms. */
export const ORBIT_CLASS_NAMES: Record<OrbitClass, string> = {
  LEO: "Low Earth orbit",
  MEO: "Medium Earth orbit",
  GEO: "Geostationary orbit",
  IGSO: "Inclined geosynchronous orbit",
  HEO: "Highly elliptical orbit",
};

/** The orbit class and shape from OMM mean elements, or null without a usable mean motion. */
export function orbitInfo(omm: Pick<SatelliteOmm, "MEAN_MOTION" | "ECCENTRICITY" | "INCLINATION"> | null | undefined): OrbitInfo | null {
  const meanMotion = omm?.MEAN_MOTION;
  if (typeof meanMotion !== "number" || !Number.isFinite(meanMotion) || meanMotion <= 0) return null;
  const rawE = omm?.ECCENTRICITY;
  const e = typeof rawE === "number" && Number.isFinite(rawE) ? Math.min(Math.max(rawE, 0), 0.999) : 0;

  const rawI = omm?.INCLINATION;
  const inclinationDeg = typeof rawI === "number" && Number.isFinite(rawI) ? Math.abs(rawI) : 0;

  const n = (meanMotion * 2 * Math.PI) / 86400; // rad/s
  const a = Math.cbrt(MU_EARTH_KM3_S2 / (n * n)); // semi-major axis, km
  const periodMin = 1440 / meanMotion;

  // Order matters: an eccentric geosynchronous orbit (Tundra) is HEO; anything else at ~1 rev/day is
  // IGSO when clearly inclined, otherwise GEO.
  const cls: OrbitClass =
    e > HEO_MIN_ECCENTRICITY
      ? "HEO"
      : meanMotion >= GEO_MIN_MEAN_MOTION && meanMotion <= GEO_MAX_MEAN_MOTION
        ? inclinationDeg > IGSO_MIN_INCLINATION_DEG
          ? "IGSO"
          : "GEO"
        : meanMotion > LEO_MIN_MEAN_MOTION
          ? "LEO"
          : "MEO";

  return {
    class: cls,
    periodMin,
    apogeeKm: a * (1 + e) - EARTH_RADIUS_KM,
    perigeeKm: a * (1 - e) - EARTH_RADIUS_KM,
  };
}

/** "93 min" under two hours, otherwise "11 h 58 min". */
export function formatOrbitPeriod(periodMin: number): string {
  const total = Math.round(periodMin);
  if (total < 120) return `${total} min`;
  return `${Math.floor(total / 60)} h ${total % 60} min`;
}

/** An altitude to 3 significant figures with a space as the thousands separator: "425", "20 200". */
export function formatOrbitAltitudeKm(km: number): string {
  const v = Math.max(0, km);
  const digits = v >= 1 ? Math.floor(Math.log10(v)) + 1 : 1;
  const step = digits > 3 ? 10 ** (digits - 3) : 1;
  const rounded = Math.round(v / step) * step;
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * "LEO · 420 km · 93 min", or "HEO · 1 200–39 000 km · 11 h 58 min" when apogee and perigee differ by
 * more than 5 % of the apogee. A near-circular orbit shows its mean altitude.
 */
export function formatOrbitSummary(info: OrbitInfo): string {
  const { apogeeKm, perigeeKm } = info;
  const altitude =
    apogeeKm - perigeeKm > 0.05 * Math.abs(apogeeKm)
      ? `${formatOrbitAltitudeKm(perigeeKm)}–${formatOrbitAltitudeKm(apogeeKm)} km`
      : `${formatOrbitAltitudeKm((apogeeKm + perigeeKm) / 2)} km`;
  return `${info.class} · ${altitude} · ${formatOrbitPeriod(info.periodMin)}`;
}
