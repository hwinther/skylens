/**
 * Pure-TypeScript device-orientation math.
 *
 * expo-sensors DeviceMotion gives us a `rotation` (alpha/beta/gamma Tait-Bryan
 * angles in the Z-X'-Y'' convention it documents) and, on some devices, a full
 * rotation matrix. We only need the camera pointing direction: for a phone held up
 * to look at the sky, the back camera looks along the device −Z axis. We build a
 * world←device rotation matrix from the Euler angles, transform the device −Z axis
 * into world ENU, and read off azimuth / elevation. Roll comes from the SCREEN up
 * (the device top rotated by the current screen-orientation angle) projected into the
 * image plane — so a landscape hold reads level once the OS has rotated the UI, exactly
 * like the web path (see webOrientation.ts).
 *
 * We then apply magnetic declination (so the gyro-derived azimuth, which is
 * relative to magnetic north via the fused rotation, is corrected to true north)
 * plus a user trim offset that lets the operator align the overlay to a known plane.
 *
 * Must import nothing from react-native / expo / react.
 */

import { deg2rad, normalizeAzimuth, rad2deg } from "./geo";

export interface DeviceRotation {
  /** Rotation around Z (yaw), radians — DeviceMotion.rotation.alpha. */
  alpha: number;
  /** Rotation around X (pitch), radians — DeviceMotion.rotation.beta. */
  beta: number;
  /** Rotation around Y (roll), radians — DeviceMotion.rotation.gamma. */
  gamma: number;
}

export interface CameraPose {
  /** Where the back camera points, compass degrees [0, 360), true north. */
  azimuth: number;
  /** Elevation of the camera bore-sight, degrees [-90, 90]. */
  elevation: number;
  /** Camera roll about the bore-sight, degrees (0 = level, + = rolled clockwise). */
  roll: number;
}

export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];

function multiplyMatVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/**
 * Build the world←device rotation matrix from DeviceMotion Euler angles.
 *
 * DeviceMotion uses the W3C DeviceOrientation intrinsic Z-X'-Y'' sequence:
 *   R = Rz(alpha) · Rx(beta) · Ry(gamma)
 * The columns of R are the device x/y/z basis vectors expressed in the world frame
 * (world = ENU-like: x East, y North, z Up), so R·v maps a device-frame vector to
 * world coordinates.
 */
export function rotationMatrixFromEuler(rot: DeviceRotation): Mat3 {
  const { alpha, beta, gamma } = rot;
  const cA = Math.cos(alpha);
  const sA = Math.sin(alpha);
  const cB = Math.cos(beta);
  const sB = Math.sin(beta);
  const cG = Math.cos(gamma);
  const sG = Math.sin(gamma);

  // R = Rz(alpha) * Rx(beta) * Ry(gamma), expanded.
  return [
    [cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG],
    [sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG],
    [-cB * sG, sB, cB * cG],
  ];
}

/**
 * Given a world←device rotation matrix, compute the back-camera pose.
 * The back camera looks along device −Z; the device "up" (top edge) is +Y.
 *
 * `screenAngleDeg` is the OS screen-orientation angle (0 portrait, 90/180/270 as the UI
 * rotates). It rotates the "up" reference off the raw device top so a landscape hold —
 * where the OS has already turned the UI + camera preview — reports roll ≈ 0 instead of
 * ~±90. Default 0 leaves the portrait behaviour (and every existing caller) unchanged.
 * On native, pass the negation of expo-sensors' DeviceMotion `orientation` (see usePoseRefs).
 */
export function poseFromMatrix(r: Mat3, screenAngleDeg = 0): CameraPose {
  // Back-camera bore-sight = device −Z axis in world coords = −(third column of R).
  const boreDevice: Vec3 = [0, 0, -1];
  const bore = multiplyMatVec(r, boreDevice);
  const [bx, by, bz] = bore; // world East, North, Up

  const horiz = Math.hypot(bx, by);
  const azimuth = normalizeAzimuth(rad2deg(Math.atan2(bx, by)));
  const elevation = rad2deg(Math.atan2(bz, horiz));

  // Roll: project the SCREEN up (device top +Y rotated about the device z by the screen
  // angle) into the plane perpendicular to the bore-sight and measure its angle from
  // world-up. Removing the bore component from the screen-up world vector gives the
  // on-image "up"; compare it to the ideal (world-up with the bore removed). Screen
  // rotation is about device-z, which leaves the bore (−Z) — and thus azimuth/elevation
  // — untouched; it only re-references which device edge is "up". Same construction as
  // webOrientation.poseFromOrientation.
  const theta = deg2rad(screenAngleDeg);
  const screenUpDevice: Vec3 = [Math.sin(theta), Math.cos(theta), 0]; // Rz(−theta)·[0,1,0]
  const topWorld = multiplyMatVec(r, screenUpDevice);
  const boreNorm = normalize(bore);
  const screenUp = normalize(subtract(topWorld, scale(boreNorm, dot(topWorld, boreNorm))));
  const worldUp: Vec3 = [0, 0, 1];
  const refUp = normalize(subtract(worldUp, scale(boreNorm, dot(worldUp, boreNorm))));

  // Signed angle between refUp and screenUp about the bore axis.
  const cross = crossProduct(refUp, screenUp);
  const sinRoll = dot(cross, boreNorm);
  const cosRoll = dot(refUp, screenUp);
  const roll = rad2deg(Math.atan2(sinRoll, cosRoll));

  return { azimuth, elevation, roll };
}

/**
 * Apply magnetic declination and the user trim to a raw camera pose azimuth.
 * declination = trueHeading − magHeading (degrees, from watchHeadingAsync); adding
 * it converts a magnetic-referenced azimuth to true north. `trim` is the manual
 * azimuth nudge from settings.
 */
export function applyDeclinationAndTrim(
  pose: CameraPose,
  declinationDeg: number,
  trimDeg: number,
): CameraPose {
  return {
    ...pose,
    azimuth: normalizeAzimuth(pose.azimuth + declinationDeg + trimDeg),
  };
}

/** Full pipeline: Euler angles → corrected back-camera pose. `screenAngleDeg` compensates
 *  for the OS screen rotation so labels stay level in landscape (see poseFromMatrix). */
export function cameraPoseFromRotation(
  rot: DeviceRotation,
  declinationDeg = 0,
  trimDeg = 0,
  screenAngleDeg = 0,
): CameraPose {
  const r = rotationMatrixFromEuler(rot);
  const pose = poseFromMatrix(r, screenAngleDeg);
  return applyDeclinationAndTrim(pose, declinationDeg, trimDeg);
}

// --- tiny vector helpers (kept local so this file has no dependencies) ---

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function crossProduct(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(a: Vec3): Vec3 {
  const len = Math.hypot(a[0], a[1], a[2]);
  if (len === 0) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}
