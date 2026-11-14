/**
 * The Radar's view rotation — pure, jest-testable, no react-native imports.
 *
 * The observer always stays at the centre; rotating only turns which true bearing points up the screen
 * (the "view bearing"). 0 is north up, today's scope. The projection (projection.ts) turns every ground
 * point into this view frame before tilting it, so terrain, rings, compass marks, blips and course
 * leaders all rotate together, and the tilt always leans towards the bottom of the screen.
 *
 * View frame: x to the screen's right, y to the screen's top, km from the observer, i.e. the ground
 * turned by −bearing. A point at true bearing θ sits at screen angle θ − bearing (clockwise from up).
 */

/** Degrees per px of horizontal drag is 180 / (π R): the scope's far rim follows the finger. */
export function dragDegPerPx(radiusPx: number): number {
  return 180 / (Math.PI * Math.max(1, radiusPx));
}

/** A view bearing in whole degrees within [0, 360); anything non-finite is north up. */
export function normalizeBearing(deg: unknown): number {
  if (typeof deg !== "number" || !Number.isFinite(deg)) return 0;
  const b = Math.round(deg) % 360;
  return b < 0 ? b + 360 : b === 0 ? 0 : b; // never −0
}

/** True while the scope is turned away from north up. */
export function isRotated(bearingDeg: number): boolean {
  return normalizeBearing(bearingDeg) !== 0;
}

/**
 * The view bearing after a horizontal drag of `dxPx` that started at `startDeg`, on a scope of radius
 * `radiusPx`. Like panning a panorama, the picture follows the finger: drag right and the far rim moves
 * right with it, i.e. the view turns left (the bearing decreases).
 */
export function dragBearing(startDeg: number, dxPx: number, radiusPx: number): number {
  return normalizeBearing(startDeg - dxPx * dragDegPerPx(radiusPx));
}

/** Ground (km east/north) → view frame (km right/up) for a view bearing. */
export function toViewKm(xKm: number, yKm: number, bearingDeg: number): { x: number; y: number } {
  if (bearingDeg === 0) return { x: xKm, y: yKm };
  const r = (bearingDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: xKm * c - yKm * s, y: xKm * s + yKm * c };
}

/** View frame (km right/up) → ground (km east/north): the inverse of {@link toViewKm}. */
export function fromViewKm(xKm: number, yKm: number, bearingDeg: number): { x: number; y: number } {
  if (bearingDeg === 0) return { x: xKm, y: yKm };
  const r = (bearingDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: xKm * c + yKm * s, y: -xKm * s + yKm * c };
}

/**
 * The terrain profiles run across the screen, so they are re-sampled for the view bearing. During a
 * drag they are rebuilt only every this many degrees (the land tint and the coast just re-project).
 */
export const RIDGE_BEARING_STEP_DEG = 5;

/** The view bearing the terrain profiles are built for: the bearing snapped to RIDGE_BEARING_STEP_DEG. */
export function ridgeBearingFor(bearingDeg: number): number {
  return normalizeBearing(Math.round(normalizeBearing(bearingDeg) / RIDGE_BEARING_STEP_DEG) * RIDGE_BEARING_STEP_DEG);
}

/**
 * Top-left of an upright `box`-px label centred `gapPx` outside the scope's rim at `pt`, pushed out
 * along the screen direction from the projected centre `origin` — so the compass letters stay upright
 * and just outside the ring whichever way the scope is turned.
 */
export function rimLabelBox(
  pt: { x: number; y: number },
  origin: { x: number; y: number },
  box: number,
  gapPx: number,
): { left: number; top: number } {
  const dx = pt.x - origin.x;
  const dy = pt.y - origin.y;
  const len = Math.hypot(dx, dy) || 1;
  // On a strongly tilted scope the ring is squashed vertically; the outward step stays a fixed px.
  return {
    left: pt.x + (dx / len) * gapPx - box / 2,
    top: pt.y + (dy / len) * gapPx - box / 2,
  };
}
