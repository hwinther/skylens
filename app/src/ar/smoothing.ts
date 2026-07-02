/**
 * Pure-TypeScript signal smoothing and dead-reckoning.
 *
 * Two concerns:
 *  1. Low-pass filtering the noisy 60 Hz camera pose so labels don't jitter. Plain
 *     exponential smoothing works for elevation/roll, but azimuth wraps at 360°, so
 *     we filter it via the shortest signed angular delta.
 *  2. Dead-reckoning aircraft positions forward between the 1 Hz snapshots using
 *     their ground speed and track, so labels track smoothly instead of stepping
 *     once a second. Given gs (knots) and track (deg) and the age of the snapshot,
 *     we advance lat/lon along a rhumb-ish local approximation and advance altitude
 *     by the vertical rate.
 *
 * Must import nothing from react-native / expo / react.
 */

import {
  angleDiff,
  deg2rad,
  METERS_PER_DEG,
  normalizeAzimuth,
} from "./geo";
import type { CameraPose } from "./orientation";

/** Knots → metres per second. */
export const KNOTS_TO_MPS = 0.514444;

/** Feet per minute → metres per second. */
export const FPM_TO_MPS = 0.00508;

/**
 * Exponential low-pass for a scalar. `alpha` is the blend of the *new* sample
 * (0 = frozen, 1 = no smoothing). At 60 Hz, alpha≈0.15 gives a ~60 ms time
 * constant, smooth but responsive.
 */
export function lowPass(prev: number, next: number, alpha: number): number {
  return prev + alpha * (next - prev);
}

/**
 * Wrap-around-safe exponential low-pass for an azimuth in degrees. Filters along
 * the shortest signed delta and re-normalises to [0, 360).
 */
export function lowPassAngle(prevDeg: number, nextDeg: number, alpha: number): number {
  const delta = angleDiff(nextDeg, prevDeg); // shortest signed path, (−180, 180]
  return normalizeAzimuth(prevDeg + alpha * delta);
}

/** Smooth a whole camera pose. Azimuth uses the wrap-safe filter. */
export function smoothPose(
  prev: CameraPose,
  next: CameraPose,
  alpha: number,
): CameraPose {
  return {
    azimuth: lowPassAngle(prev.azimuth, next.azimuth, alpha),
    elevation: lowPass(prev.elevation, next.elevation, alpha),
    roll: lowPassAngle(prev.roll, next.roll, alpha),
  };
}

export interface DeadReckonInput {
  lat: number;
  lon: number;
  /** Altitude in metres. */
  alt: number;
  /** Ground speed in knots. */
  gs: number;
  /** Track (course over ground) in degrees, 0 = North, clockwise. */
  trk: number;
  /** Vertical rate in feet per minute (optional). */
  vr?: number;
}

export interface DeadReckoned {
  lat: number;
  lon: number;
  alt: number;
}

/**
 * Advance an aircraft position forward by `dtSeconds` using its ground speed and
 * track (great-circle-free local flat-earth step, fine for a few seconds), and its
 * vertical rate for altitude. Returns the original position when gs/trk are missing.
 */
export function deadReckon(ac: DeadReckonInput, dtSeconds: number): DeadReckoned {
  if (dtSeconds <= 0 || !Number.isFinite(ac.gs) || !Number.isFinite(ac.trk)) {
    return { lat: ac.lat, lon: ac.lon, alt: ac.alt };
  }
  const distanceM = ac.gs * KNOTS_TO_MPS * dtSeconds;
  const trkRad = deg2rad(ac.trk);
  const dN = distanceM * Math.cos(trkRad); // north component
  const dE = distanceM * Math.sin(trkRad); // east component

  const dLat = dN / METERS_PER_DEG;
  const dLon = dE / (METERS_PER_DEG * Math.cos(deg2rad(ac.lat)));

  const vrMps = Number.isFinite(ac.vr as number) ? (ac.vr as number) * FPM_TO_MPS : 0;
  const dAlt = vrMps * dtSeconds;

  return {
    lat: ac.lat + dLat,
    lon: ac.lon + dLon,
    alt: ac.alt + dAlt,
  };
}
