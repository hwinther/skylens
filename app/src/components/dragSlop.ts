/**
 * The one "this press became a drag" threshold for the AR view. Drag-to-look is a gesture-handler Pan,
 * and anything that should only react to a still press (a label tap, the identify long-press) gives up
 * once the pointer has moved this far.
 */

/** Movement (px) after which a press counts as a drag, not a tap or a hold. */
export const DRAG_SLOP_PX = 10;

export interface PagePoint {
  pageX: number;
  pageY: number;
}

/** The page coordinates of a press/pointer/click event, or null when it has none (keyboard, a11y). */
export function pagePoint(e: { nativeEvent?: unknown } | null | undefined): PagePoint | null {
  const ne = e?.nativeEvent as { pageX?: unknown; pageY?: unknown } | undefined;
  if (typeof ne?.pageX !== "number" || typeof ne?.pageY !== "number") return null;
  if (!Number.isFinite(ne.pageX) || !Number.isFinite(ne.pageY)) return null;
  return { pageX: ne.pageX, pageY: ne.pageY };
}

/** True when the pointer moved more than DRAG_SLOP_PX between the two points. */
export function movedBeyondSlop(from: PagePoint, to: PagePoint): boolean {
  return Math.hypot(to.pageX - from.pageX, to.pageY - from.pageY) > DRAG_SLOP_PX;
}
