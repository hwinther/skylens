/**
 * Pure-TypeScript Polaris ephemeris + azimuth-trim solver for the AR compass calibration.
 *
 * Polaris (the North Star) sits within ~0.7° of the true celestial north pole, so its azimuth is
 * essentially 0° (true north) from anywhere in the northern hemisphere, and its elevation ≈ the
 * observer's latitude (the classic latitude-by-Polaris check sailors have used for centuries). That
 * makes it a free, always-available calibration reference: aim the AR crosshair at Polaris, and any
 * gap between where the pose says it is pointing and Polaris's true azimuth IS the compass error —
 * which we fold straight into the manual `azimuthTrimDeg`.
 *
 * Like planets.ts / radioSky.ts this is a deterministic function of (observer, instant) computed with
 * `astronomy-engine` (pure JS), so it imports nothing from react-native / expo / react (see the
 * src/ar/ eslint guard) and jest can exercise it on any platform.
 *
 * `DefineStar` writes one of eight shared global "star" slots (Star1..Star8). radioSky.ts owns
 * Star1..Star4; we use Star8 here so the two modules never collide. (Both always redefine their slot
 * before reading, so a result never depends on call order — but keeping the slots disjoint keeps that
 * discipline obvious and lets the two run interleaved without a second thought.)
 */

import { Body, DefineStar, Equator, Horizon, Observer } from "astronomy-engine";
import { angleDiff, normalizeAzimuth } from "./geo";

/** Polaris (Alpha Ursae Minoris): J2000 position + rough distance. ~0.7° from the true north pole. */
export const POLARIS = { raHours: 2.5303, decDeg: 89.2641, distanceLy: 433 };

/**
 * Sanity tolerance (deg) for the calibration: Polaris's elevation should match where the pose is
 * pointing to within this. Polaris's elevation ≈ the observer's latitude, so if the user aims tens of
 * degrees off in elevation they are almost certainly locked onto the wrong star — we warn rather than
 * silently apply a bogus trim.
 */
export const POLARIS_ELEVATION_TOLERANCE_DEG = 10;

/** Observer position for the ephemeris: geodetic lat/lon (deg) + optional altitude (metres). */
export interface PolarisObserver {
  lat: number;
  lon: number;
  alt?: number;
}

/**
 * Compute Polaris's observer-relative look angles at `date`. Same reduction planets.ts / radioSky.ts
 * use: `DefineStar` the J2000 RA/Dec into a stable slot (Star8, disjoint from radioSky's Star1..Star4),
 * then `Equator(star, date, observer, ofdate=true, aberration=true)` → apparent RA/Dec of date, fed to
 * `Horizon(..., "normal")` for a refraction-corrected azimuth/altitude. Redefining the slot before the
 * read makes the result independent of call order. Azimuth is ~0° (true north); elevation ≈ latitude.
 */
export function polarisAltAz(
  observer: PolarisObserver,
  date: Date,
): { azimuthDeg: number; elevationDeg: number } {
  const obs = new Observer(observer.lat, observer.lon, observer.alt ?? 0);
  DefineStar(Body.Star8, POLARIS.raHours, POLARIS.decDeg, POLARIS.distanceLy);
  const eq = Equator(Body.Star8, date, obs, true, true);
  const hor = Horizon(date, obs, eq.ra, eq.dec, "normal");
  return { azimuthDeg: normalizeAzimuth(hor.azimuth), elevationDeg: hor.altitude };
}

/**
 * Solve for the azimuth trim that makes the pose report Polaris's true azimuth while the user aims at
 * it.
 *
 * The pose applies trim ADDITIVELY on the sensor azimuth (`pose.azimuth = sensorRaw + trim`, see
 * orientation.ts `applyDeclinationAndTrim` and useWebArSensors), so the value the pose currently REPORTS
 * while aimed at Polaris — `pointedAzimuthDeg` — already has `currentTrimDeg` baked in. The raw
 * (untrimmed) sensor reading is therefore `pointedAzimuthDeg − currentTrimDeg`. We want the NEW trim
 * that lands the raw reading exactly on Polaris's true azimuth:
 *
 *     sensorRaw + newTrim = polarisAz   ⟹   newTrim = polarisAz − sensorRaw
 *                                            = polarisAz − (pointedAzimuthDeg − currentTrimDeg)
 *
 * wrapped to (−180, 180] via `angleDiff` (which returns `a − b` in exactly that range). Being additive
 * on the current trim is what makes this idempotent: re-running with the freshly applied trim, aimed at
 * the same star, yields the same trim back.
 *
 * When `pointedElevationDeg` is supplied we also return `elevationErrorDeg = |pointed − polarisEl|`, the
 * classic sanity check (Polaris's elevation ≈ the observer's latitude): a large error means the user is
 * almost certainly not on Polaris.
 */
export function solveAzimuthTrim(opts: {
  pointedAzimuthDeg: number;
  currentTrimDeg: number;
  observer: PolarisObserver;
  date: Date;
  pointedElevationDeg?: number;
}): { newTrimDeg: number; polarisElevationDeg: number; elevationErrorDeg?: number } {
  const { pointedAzimuthDeg, currentTrimDeg, observer, date, pointedElevationDeg } = opts;
  const polaris = polarisAltAz(observer, date);
  const sensorRaw = pointedAzimuthDeg - currentTrimDeg; // strip the trim already baked into the pose
  const newTrimDeg = angleDiff(polaris.azimuthDeg, sensorRaw); // (polarisAz − raw), wrapped to (−180, 180]
  return {
    newTrimDeg,
    polarisElevationDeg: polaris.elevationDeg,
    ...(pointedElevationDeg != null
      ? { elevationErrorDeg: Math.abs(pointedElevationDeg - polaris.elevationDeg) }
      : {}),
  };
}
