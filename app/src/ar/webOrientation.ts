/**
 * Pure-TypeScript W3C DeviceOrientation → CameraPose math for the web AR path.
 *
 * A mobile browser's `deviceorientation` / `deviceorientationabsolute` events carry
 * the intrinsic Z-X'-Y'' Tait-Bryan angles (alpha/beta/gamma, degrees) the W3C spec
 * defines. We reuse the exact same rotation-matrix convention as the native pipeline
 * (see orientation.ts): the columns of R are the device x/y/z axes expressed in world
 * ENU (x East, y North, z Up), so R·v maps a device-frame vector into the world.
 *
 * The back ("environment") camera looks along the device −Z axis, so its world
 * pointing vector is R·[0,0,−1]; azimuth/elevation read straight off that. Roll is the
 * SCREEN up direction (device top rotated by the screen-orientation angle) projected
 * perpendicular to the bore — the browser rotates the video feed to match the screen,
 * so the displayed image's "up" follows the screen, not the raw device top.
 *
 * iOS quirk: its non-absolute `alpha` has an arbitrary per-page origin, but Safari also
 * exposes `webkitCompassHeading` (true magnetic heading of the device top). We use it to
 * re-reference the azimuth to north.
 *
 * Must import nothing from react-native / expo / react (eslint-guarded) so jest runs it.
 */

import { deg2rad, normalizeAzimuth, rad2deg } from "./geo";
import { rotationMatrixFromEuler, type CameraPose, type Mat3, type Vec3 } from "./orientation";

export interface WebOrientationSample {
  /** DeviceOrientationEvent.alpha — rotation about Z (yaw), degrees. */
  alpha: number;
  /** DeviceOrientationEvent.beta — rotation about X (pitch), degrees. */
  beta: number;
  /** DeviceOrientationEvent.gamma — rotation about Y (roll), degrees. */
  gamma: number;
  /** DeviceOrientationEvent.absolute — true when alpha is referenced to Earth (Android). */
  absolute: boolean;
  /** iOS-only true magnetic heading (deg CW from north) of the device TOP, not the camera. */
  webkitCompassHeading?: number;
  /** Screen orientation angle (0 / 90 / 180 / 270), from screen.orientation.angle or window.orientation. */
  screenAngle: number;
}

/**
 * Convert a W3C DeviceOrientation sample to a back-camera pose (true/magnetic north).
 * Returns null when any of alpha/beta/gamma is missing (null / NaN) — the caller then
 * keeps the previous pose instead of writing garbage.
 */
export function poseFromOrientation(s: WebOrientationSample): CameraPose | null {
  const { alpha, beta, gamma, absolute, webkitCompassHeading, screenAngle } = s;
  if (!Number.isFinite(alpha) || !Number.isFinite(beta) || !Number.isFinite(gamma)) {
    return null;
  }

  // Device←world rotation from the intrinsic Z-X'-Y'' angles (same matrix as native).
  const r: Mat3 = rotationMatrixFromEuler({
    alpha: deg2rad(alpha),
    beta: deg2rad(beta),
    gamma: deg2rad(gamma),
  });

  // Back camera bore-sight = device −Z in world ENU. Screen rotation is a rotation about
  // the device z-axis, which leaves −Z (and therefore azimuth/elevation) invariant — it
  // only re-orients the image "up", handled in the roll block below.
  const bore = matVec(r, [0, 0, -1]);
  const [bx, by, bz] = bore; // East, North, Up
  const horiz = Math.hypot(bx, by);
  let azimuth = normalizeAzimuth(rad2deg(Math.atan2(bx, by))); // 0 = N, 90 = E
  const elevation = rad2deg(Math.atan2(bz, horiz));

  // Roll about the bore: take the SCREEN "up" (device top rotated about screen z by
  // −screenAngle), project it perpendicular to the bore, and measure its signed angle
  // from world-up projected the same way. Identical construction to native poseFromMatrix,
  // but fed the screen-compensated up vector instead of the raw device top.
  const theta = deg2rad(screenAngle);
  const screenUpDevice: Vec3 = [Math.sin(theta), Math.cos(theta), 0]; // Rz(−theta)·[0,1,0]
  const topWorld = matVec(r, screenUpDevice);
  const boreNorm = normalize(bore);
  const screenUp = normalize(sub(topWorld, scale(boreNorm, dot(topWorld, boreNorm))));
  const worldUp: Vec3 = [0, 0, 1];
  const refUp = normalize(sub(worldUp, scale(boreNorm, dot(worldUp, boreNorm))));
  const cross = crossProduct(refUp, screenUp);
  const roll = rad2deg(Math.atan2(dot(cross, boreNorm), dot(refUp, screenUp)));

  // iOS re-referencing: alpha's origin is arbitrary, so shift the whole azimuth by the
  // difference between the compass-true heading of the device top and the top's azimuth
  // as our (arbitrary-origin) matrix computes it. webkitCompassHeading and our azimuth are
  // both degrees clockwise from north, so they subtract directly.
  if (!absolute && webkitCompassHeading != null && Number.isFinite(webkitCompassHeading)) {
    const top = matVec(r, [0, 1, 0]); // physical device top edge, world ENU
    const topAz = normalizeAzimuth(rad2deg(Math.atan2(top[0], top[1])));
    azimuth = normalizeAzimuth(azimuth + (webkitCompassHeading - topAz));
  }

  return { azimuth, elevation, roll };
}

// --- tiny local vector helpers (kept local so this file stays dependency-free) ---

function matVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function crossProduct(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(a: Vec3): Vec3 {
  const len = Math.hypot(a[0], a[1], a[2]);
  if (len === 0) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}
