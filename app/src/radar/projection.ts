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
 *
 * Rotation (`bearingDeg`, the true bearing that points up the screen; see rotation.ts) turns the ground
 * into the view frame first, so the tilt always leans towards the bottom of the screen. Bearing 0 is the
 * north-up scope, bit for bit.
 */

import { fromViewKm, normalizeBearing } from "./rotation";

/** Steepest tilt the control allows, in degrees. */
export const MAX_TILT_DEG = 80;

/**
 * Past 60° a true cos t squash would flatten the disc into an unreadable strip (cos 80° ≈ 0.17), so
 * the tilt eases from there: the vertical squash goes linearly from cos 60° = 0.5 down to this at
 * MAX_TILT_DEG instead, and the relief grows by up to RELIEF_BOOST_AT_MAX, so the steepest tilts read
 * as a low view across the land with its hills standing up. Up to 60° the projection is unchanged.
 */
const EASE_FROM_DEG = 60;
const SQUASH_AT_MAX = 0.3;
const RELIEF_BOOST_AT_MAX = 1.5;

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
  /** The ground's vertical squash: cos t up to 60°, eased beyond (see groundSquash). */
  cos: number;
  /** Camera distance in px. */
  D: number;
  /** Overall scale so the near (south) rim keeps the flat radar's width. */
  fit: number;
  /** Projected y of the ground origin. */
  cy0: number;
  /** Height scale: px per metre (before the sin t factor). */
  zPxPerM: number;
  /** View bearing: the true bearing that points up the screen (whole degrees, 0 = north up). */
  bearingDeg: number;
  /** cos / sin of the view bearing. */
  bCos: number;
  bSin: number;
}

export interface ProjectionInput {
  /** Side of the square box in px. */
  size: number;
  /** Outer-ring range in km. */
  rangeKm: number;
  tiltDeg: number;
  /** Highest terrain height in view (m); picks the relief exaggeration. 0 when there is no terrain. */
  reliefMaxM?: number;
  /** View bearing (deg true up the screen); 0 / omitted = north up. */
  bearingDeg?: number;
}

/** A tilt in whole degrees within [0, MAX_TILT_DEG]; anything non-finite is flat. */
export function clampTilt(deg: unknown): number {
  if (typeof deg !== "number" || !Number.isFinite(deg)) return 0;
  return Math.round(Math.min(MAX_TILT_DEG, Math.max(0, deg)));
}

export function makeRadarProjection({
  size,
  rangeKm,
  tiltDeg,
  reliefMaxM = 0,
  bearingDeg = 0,
}: ProjectionInput): RadarProjection {
  const tilt = clampTilt(tiltDeg);
  const bearing = normalizeBearing(bearingDeg);
  const b = (bearing * Math.PI) / 180;
  const R = Math.max(1, size / 2 - SCOPE_PADDING_PX);
  const t = (tilt * Math.PI) / 180;
  const sin = Math.sin(t);
  const cos = groundSquash(tilt);
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
    zPxPerM: (RELIEF_FRACTION * R * reliefBoost(tilt)) / ref,
    bearingDeg: bearing,
    bCos: bearing === 0 ? 1 : Math.cos(b),
    bSin: bearing === 0 ? 0 : Math.sin(b),
  };
}

/** How far tilting past EASE_FROM_DEG has gone, 0 → 1 at MAX_TILT_DEG. */
function easeAmount(tiltDeg: number): number {
  return Math.min(1, Math.max(0, (tiltDeg - EASE_FROM_DEG) / (MAX_TILT_DEG - EASE_FROM_DEG)));
}

/** The vertical squash of the ground at a tilt: cos t up to 60°, then easing to SQUASH_AT_MAX. */
export function groundSquash(tiltDeg: number): number {
  if (tiltDeg <= EASE_FROM_DEG) return Math.cos((tiltDeg * Math.PI) / 180);
  const at = Math.cos((EASE_FROM_DEG * Math.PI) / 180);
  return at + (SQUASH_AT_MAX - at) * easeAmount(tiltDeg);
}

/** The relief exaggeration factor at a tilt: 1 up to 60°, growing to RELIEF_BOOST_AT_MAX. */
export function reliefBoost(tiltDeg: number): number {
  return 1 + (RELIEF_BOOST_AT_MAX - 1) * easeAmount(tiltDeg);
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** Perspective scale at this point (1 when flat). */
  s: number;
}

/** Ground point (km east/north of the observer) at height zM → screen px. */
export function projectPoint(p: RadarProjection, xKm: number, yKm: number, zM = 0): ScreenPoint {
  // Into the view frame (right / up the screen); a no-op north up.
  const vx = p.bearingDeg === 0 ? xKm : xKm * p.bCos - yKm * p.bSin;
  const vy = p.bearingDeg === 0 ? yKm : xKm * p.bSin + yKm * p.bCos;
  const gx = vx * p.pxPerKm;
  const gy = vy * p.pxPerKm;
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
  const g = fromViewKm(gx / p.pxPerKm, gy / p.pxPerKm, p.bearingDeg);
  return { xKm: g.x, yKm: g.y };
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
