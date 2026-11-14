/**
 * The tiltable Radar's projection — pure, jest-testable, no react-native imports.
 *
 * The scope lives on a ground plane: x east, y north, in km from the observer, plus a height z in metres.
 * Flat (tilt 0) is today's radar exactly: a top-down disc, `R` px for the range, north up. Tilting swings
 * the camera down towards the south horizon, like leaning over a sand-table: the disc foreshortens
 * vertically (cos t), the far (north) side shrinks a little in perspective, and heights rise on screen
 * by z·sin t, so relief appears gradually as you tilt. Everything on the scope — terrain, range rings,
 * labels, blips and their tap targets — goes through {@link projectPoint}, so they stay registered.
 *
 * The depth used for perspective is the ground position only (heights don't change the scale), so at
 * tilt 0 every point lands exactly where the flat radar draws it, whatever its height.
 */

/** Steepest tilt the control allows, in degrees. */
export const MAX_TILT_DEG = 60;

/** Camera distance in units of the scope radius: smaller = stronger perspective. */
const PERSPECTIVE_DISTANCE_R = 4;

/** Screen height (as a fraction of R, before the sin t factor) that the reference height rises to. */
const RELIEF_FRACTION = 0.22;

/** Range of the reference height: flat country isn't blown up into alps, high mountains don't explode. */
const RELIEF_REF_MIN_M = 600;
const RELIEF_REF_MAX_M = 2500;

/** Padding between the square box and the outer ring, as the flat radar has always had. */
export const SCOPE_PADDING_PX = 18;

export interface RadarProjection {
  /** Centre of the square box. */
  cx: number;
  cy: number;
  /** Outer-ring radius in px (flat). */
  R: number;
  /** px per km on the ground at the centre (flat). */
  pxPerKm: number;
  tiltDeg: number;
  sin: number;
  cos: number;
  /** Camera distance in px. */
  D: number;
  /** Overall scale so the near (south) rim keeps the flat radar's width. */
  fit: number;
  /** Projected y of the ground origin. */
  cy0: number;
  /** Height scale: px per metre (before the sin t factor). */
  zPxPerM: number;
}

export interface ProjectionInput {
  /** Side of the square box in px. */
  size: number;
  /** Outer-ring range in km. */
  rangeKm: number;
  tiltDeg: number;
  /** Highest terrain height in view (m); picks the relief exaggeration. 0 when there is no terrain. */
  reliefMaxM?: number;
}

/** A tilt in whole degrees within [0, MAX_TILT_DEG]; anything non-finite is flat. */
export function clampTilt(deg: unknown): number {
  if (typeof deg !== "number" || !Number.isFinite(deg)) return 0;
  return Math.round(Math.min(MAX_TILT_DEG, Math.max(0, deg)));
}

export function makeRadarProjection({ size, rangeKm, tiltDeg, reliefMaxM = 0 }: ProjectionInput): RadarProjection {
  const tilt = clampTilt(tiltDeg);
  const R = Math.max(1, size / 2 - SCOPE_PADDING_PX);
  const t = (tilt * Math.PI) / 180;
  const sin = Math.sin(t);
  const cos = Math.cos(t);
  const D = PERSPECTIVE_DISTANCE_R * R;
  // Perspective scale of the near and far rim; `fit` brings the near rim back to the flat width.
  const sNear = D / (D - R * sin);
  const sFar = D / (D + R * sin);
  const fit = 1 / sNear;
  // Centre the foreshortened disc vertically, nudged down a little to leave headroom for the relief.
  const headroom = 0.06 * R * sin;
  const cy = size / 2;
  const cy0 = cy + headroom - (R * cos * (1 - fit * sFar)) / 2;
  const ref = Math.min(RELIEF_REF_MAX_M, Math.max(RELIEF_REF_MIN_M, reliefMaxM));
  return {
    cx: size / 2,
    cy,
    R,
    pxPerKm: R / Math.max(rangeKm, 1e-6),
    tiltDeg: tilt,
    sin,
    cos,
    D,
    fit,
    cy0,
    zPxPerM: (RELIEF_FRACTION * R) / ref,
  };
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** Perspective scale at this point (1 when flat). */
  s: number;
}

/** Ground point (km east/north of the observer) at height zM → screen px. */
export function projectPoint(p: RadarProjection, xKm: number, yKm: number, zM = 0): ScreenPoint {
  const gx = xKm * p.pxPerKm;
  const gy = yKm * p.pxPerKm;
  const s = p.D / (p.D + gy * p.sin);
  const k = p.fit * s;
  return { x: p.cx + gx * k, y: p.cy0 - (gy * p.cos + zM * p.zPxPerM * p.sin) * k, s: k };
}

/** Bearing (deg true) + distance (km) → ground km offset. */
export function polarToKm(distanceKm: number, bearingDeg: number): { xKm: number; yKm: number } {
  const rad = (bearingDeg * Math.PI) / 180;
  return { xKm: distanceKm * Math.sin(rad), yKm: distanceKm * Math.cos(rad) };
}

/**
 * Screen px → the ground point (height 0) under it: the inverse of {@link projectPoint} for z = 0. Null
 * when the ray misses the ground (above the projected horizon). Lets a tap on the tilted scope be read
 * back as a place, and pins the projection's consistency in tests.
 */
export function unprojectGround(p: RadarProjection, sx: number, sy: number): { xKm: number; yKm: number } | null {
  const a = (sx - p.cx) / p.fit;
  const b = (p.cy0 - sy) / p.fit;
  const denom = p.D * p.cos - b * p.sin;
  if (denom <= 1e-9) return null;
  const gy = (b * p.D) / denom;
  const s = p.D / (p.D + gy * p.sin);
  if (!(s > 0)) return null;
  const gx = a / s;
  return { xKm: gx / p.pxPerKm, yKm: gy / p.pxPerKm };
}

/** Top-left of a `box`-px square tap target centred on a projected point (blips are 24 px). */
export function boxAt(pt: ScreenPoint, box: number): { left: number; top: number } {
  return { left: pt.x - box / 2, top: pt.y - box / 2 };
}

/** True when a screen point lies inside the `box`-px tap target centred on `pt` (plus a hit slop). */
export function hitsBox(pt: ScreenPoint, box: number, sx: number, sy: number, slop = 0): boolean {
  const half = box / 2 + slop;
  return Math.abs(sx - pt.x) <= half && Math.abs(sy - pt.y) <= half;
}

/**
 * A closed ground circle (radius km, height 0) as an SVG path — a range ring under tilt. Perspective
 * makes it an egg rather than an exact ellipse, so it is drawn as a polygon.
 */
export function ringPath(p: RadarProjection, radiusKm: number, segments = 72): string {
  const parts: string[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * 2 * Math.PI;
    const pt = projectPoint(p, radiusKm * Math.sin(a), radiusKm * Math.cos(a));
    parts.push(`${i === 0 ? "M" : "L"}${r1(pt.x)} ${r1(pt.y)}`);
  }
  return parts.join("") + "Z";
}

/** Round to 0.1 px for compact path strings. */
export function r1(v: number): number {
  return Math.round(v * 10) / 10;
}
