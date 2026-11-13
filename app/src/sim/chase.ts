/**
 * Pure-TS pose math for the cockpit view's outside ("chase") camera: instead of riding in the followed
 * object, the camera sits behind and above it and looks at it. There is no 3D model: the object is a
 * point plus a flat chevron along its heading (chevronEnu), drawn by src/sim/simGlobe.ts.
 *
 * Look-around keeps its meaning: the look offset orbits the camera around the object. Yaw turns the
 * view (looking 30° right puts the camera so it looks 30° right of the heading, at the object); pitch
 * up lowers the camera towards the object's level, pitch down raises it towards straight above.
 * Recenter (look = 0) is straight behind at the kind's base elevation.
 *
 * Offsets are in the object's local east-north-up frame, metres. Free of Cesium so jest runs it.
 */

import { normalizeAzimuth } from "@/ar/geo";
import type { Look } from "./look";
import type { SimKind } from "./simPose";

export type CameraMode = "cockpit" | "chase";

export const CAMERA_MODES: readonly CameraMode[] = ["cockpit", "chase"];

export interface ChaseSpec {
  /** Camera distance from the object, metres. */
  distanceM: number;
  /** Camera elevation above the object's horizon at look = 0, degrees. */
  elevationDeg: number;
}

/** Per kind: close enough to see the object's motion against the ground, far enough to see around it. */
export function chaseSpec(kind: SimKind): ChaseSpec {
  switch (kind) {
    case "aircraft":
      return { distanceM: 350, elevationDeg: 12 };
    case "vessel":
      return { distanceM: 220, elevationDeg: 18 };
    case "satellite":
      return { distanceM: 4000, elevationDeg: 20 };
  }
}

/** The chase camera's elevation stays within these, so it never dips under the object or flips over it. */
export const MIN_CHASE_ELEVATION_DEG = 2;
export const MAX_CHASE_ELEVATION_DEG = 85;

export interface ChaseCamera {
  /** Camera position relative to the object, local ENU metres. */
  east: number;
  north: number;
  up: number;
  /** Camera heading and pitch (degrees; pitch negative = looking down), towards the object. */
  headingDeg: number;
  pitchDeg: number;
}

export function chaseCamera(headingDeg: number, look: Look, spec: ChaseSpec): ChaseCamera {
  const elev = Math.max(MIN_CHASE_ELEVATION_DEG, Math.min(MAX_CHASE_ELEVATION_DEG, spec.elevationDeg - look.pitch));
  const view = normalizeAzimuth(headingDeg + look.yaw);
  const v = (view * Math.PI) / 180;
  const e = (elev * Math.PI) / 180;
  const horizontal = spec.distanceM * Math.cos(e);
  return {
    // Opposite the viewing direction, so the object is dead ahead of the camera.
    east: -Math.sin(v) * horizontal,
    north: -Math.cos(v) * horizontal,
    up: spec.distanceM * Math.sin(e),
    headingDeg: view,
    pitchDeg: -elev,
  };
}

export interface Enu {
  east: number;
  north: number;
  up: number;
}

/**
 * The flat arrowhead marking the followed object in the chase view, pointing along `headingDeg`: a
 * closed outline (wing tip, nose, other wing tip, notch, first tip) `sizeM` from nose to wing tips.
 */
export function chevronEnu(headingDeg: number, sizeM: number): Enu[] {
  const at = (bearingDeg: number, r: number): Enu => {
    const b = ((headingDeg + bearingDeg) * Math.PI) / 180;
    return { east: Math.sin(b) * r, north: Math.cos(b) * r, up: 0 };
  };
  const left = at(-145, sizeM * 0.7);
  return [left, at(0, sizeM * 0.6), at(145, sizeM * 0.7), at(180, sizeM * 0.15), left];
}

/** The chevron's size for the chase distance: big enough to read, small next to the view. */
export function chevronSizeM(spec: ChaseSpec): number {
  return spec.distanceM * 0.12;
}
