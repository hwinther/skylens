/**
 * Pure-TypeScript pinhole projection from world look-angles to normalised screen
 * coordinates, given a camera pose and horizontal field of view.
 *
 * We work in a gnomonic (pinhole) model: the horizontal offset uses
 *   xNdc = tan(dAz) / tan(hFov/2)
 * where dAz is the signed azimuth difference between the target and the camera
 * bore-sight. The vertical offset uses the elevation difference scaled by the same
 * focal length but corrected for aspect ratio so a square-ish FOV maps correctly.
 * We then rotate (x, y) by the camera roll so labels stay glued to the world when
 * the phone is tilted.
 *
 * Targets outside the FOV (|xNdc| or |yNdc| beyond 1 + margin) are culled and, if
 * they are within the forward hemisphere (angular distance < 90°), classified as
 * off-screen so the overlay can draw a direction arrow at the frame edge.
 *
 * NDC convention: x ∈ [-1, 1] left→right, y ∈ [-1, 1] bottom→top (up is +y).
 * The screen mapper (in the RN layer) flips y for pixel space.
 *
 * Must import nothing from react-native / expo / react.
 */

import { angleDiff, deg2rad, normalizeAzimuth } from "./geo";
import type { CameraPose } from "./orientation";

export interface ProjectionInput {
  /** Target azimuth, degrees true, [0, 360). */
  azimuth: number;
  /** Target elevation, degrees, [-90, 90]. */
  elevation: number;
}

export interface ProjectionConfig {
  /** Horizontal field of view in degrees (default 66). */
  hFovDeg: number;
  /** Screen aspect ratio = width / height. Used to derive the vertical FOV. */
  aspect: number;
  /** Extra NDC margin before a target is treated as off-screen (default 0.15). */
  cullMargin: number;
}

export const DEFAULT_HFOV_DEG = 66;

export const DEFAULT_PROJECTION_CONFIG: ProjectionConfig = {
  hFovDeg: DEFAULT_HFOV_DEG,
  aspect: 9 / 16, // portrait phone: narrower than tall
  cullMargin: 0.15,
};

export interface Projected {
  /** Normalised device x, [-1, 1] center=0 (may exceed when off-screen). */
  xNdc: number;
  /** Normalised device y, [-1, 1] center=0, up is positive. */
  yNdc: number;
  /** True when the target is within the (margin-expanded) frustum. */
  onScreen: boolean;
  /**
   * When off-screen but within the forward hemisphere, the bearing to draw an edge
   * arrow, in degrees measured clockwise from screen-up (0 = up, 90 = right).
   * `null` when on-screen or behind the camera.
   */
  arrowBearingDeg: number | null;
  /** True when the target is behind the camera (angular distance ≥ 90°). */
  behind: boolean;
}

/** Rotate a 2-D NDC point by the camera roll (clockwise-positive) about the center. */
function applyRoll(x: number, y: number, rollDeg: number): [number, number] {
  const r = deg2rad(rollDeg);
  const c = Math.cos(r);
  const s = Math.sin(r);
  // Rolling the camera clockwise rolls the world counter-clockwise on screen.
  return [x * c + y * s, -x * s + y * c];
}

/**
 * Project a target's look-angles into NDC given the camera pose and config.
 */
export function project(
  target: ProjectionInput,
  pose: CameraPose,
  config: ProjectionConfig = DEFAULT_PROJECTION_CONFIG,
): Projected {
  const dAz = angleDiff(normalizeAzimuth(target.azimuth), pose.azimuth); // deg, right-positive
  const dEl = target.elevation - pose.elevation; // deg, up-positive

  const halfH = config.hFovDeg / 2;
  // Vertical FOV derived from aspect (aspect = w/h → vFov relates by 1/aspect).
  const vFovDeg = rad2degSafe(
    2 * Math.atan(Math.tan(deg2rad(halfH)) / Math.max(config.aspect, 1e-6)),
  );
  const halfV = vFovDeg / 2;

  const tanHalfH = Math.tan(deg2rad(halfH));
  const tanHalfV = Math.tan(deg2rad(halfV));

  // Behind the camera: the along-bore component is negative. Angular distance from
  // bore in the horizontal sense alone doesn't capture pitch, so combine both.
  const angularDist = greatCircleAngle(dAz, dEl);
  const behind = angularDist >= 90;

  let xNdc = Math.tan(deg2rad(dAz)) / tanHalfH;
  let yNdc = Math.tan(deg2rad(dEl)) / tanHalfV;

  // For points near/behind 90° the tangent explodes; clamp to a large sentinel so
  // downstream arrow logic still has a direction but we never render them on-screen.
  if (!Number.isFinite(xNdc) || Math.abs(xNdc) > 1e4) xNdc = Math.sign(dAz || 1) * 1e4;
  if (!Number.isFinite(yNdc) || Math.abs(yNdc) > 1e4) yNdc = Math.sign(dEl || 1) * 1e4;

  [xNdc, yNdc] = applyRoll(xNdc, yNdc, pose.roll);

  const limit = 1 + config.cullMargin;
  const onScreen = !behind && Math.abs(xNdc) <= limit && Math.abs(yNdc) <= limit;

  let arrowBearingDeg: number | null = null;
  if (!onScreen && !behind) {
    // Screen bearing: 0 = up, clockwise positive. y is up-positive in NDC.
    arrowBearingDeg = normalizeAzimuth(rad2degSafe(Math.atan2(xNdc, yNdc)));
  } else if (behind) {
    // Behind: point the arrow toward the shorter turn (left/right) using dAz sign.
    arrowBearingDeg = dAz >= 0 ? 90 : 270;
  }

  return { xNdc, yNdc, onScreen, arrowBearingDeg, behind };
}

/** Angular great-circle distance (deg) of a target offset (dAz, dEl) from bore. */
function greatCircleAngle(dAzDeg: number, dElDeg: number): number {
  const dAz = deg2rad(dAzDeg);
  const dEl = deg2rad(dElDeg);
  // Bore direction = (0,0). Target unit vector in a camera frame where x=right,
  // y=up, z=forward: forward component cos(el)cos(az).
  const cosAngle = Math.cos(dEl) * Math.cos(dAz);
  const clamped = Math.max(-1, Math.min(1, cosAngle));
  return rad2degSafe(Math.acos(clamped));
}

function rad2degSafe(r: number): number {
  return (r * 180) / Math.PI;
}
