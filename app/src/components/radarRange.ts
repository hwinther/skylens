/**
 * Radar range-zoom stepping — pure, jest-testable helpers with no react-native imports.
 *
 * The radar can auto-scale its outer ring to the farthest blip (range `0` = "Auto") or lock to one
 * of a few tidy fixed ranges. `zoomIn`/`zoomOut` walk that fixed ladder. From Auto the ladder entry
 * point is derived from the current auto range so the first tap always visibly changes the picture:
 *   - zoom in  → the largest fixed range strictly *below* the auto range (magnify past the fit)
 *   - zoom out → the smallest fixed range strictly *above* the auto range (pull back past the fit)
 * Once on a fixed range you step through the ladder and clamp at its ends (2 km … 500 km). Auto is
 * only re-entered by resetting (tapping the range chip), never by stepping.
 */

/** Selectable ranges for the zoom control, in display order. `0` renders as "Auto" (auto-scale). */
export const RADAR_RANGE_PRESETS = [0, 500, 250, 100, 50, 25, 10, 5, 2] as const;

/** Fixed range stops in ascending km — the ladder `zoomIn`/`zoomOut` walk (excludes Auto). */
const STOPS = [2, 5, 10, 25, 50, 100, 250, 500] as const;

/** `true` when `km` means auto-scale (0, negative, or nullish). */
export function isAutoRange(km: number | undefined | null): boolean {
  return km == null || km <= 0;
}

/**
 * Range to zoom *in* to (a smaller km ring). `current` is the active range (`0` = Auto); `autoRangeKm`
 * is the range the radar auto-derived from the data, used only when `current` is Auto. Returns
 * `current` unchanged when already at the innermost stop (nothing smaller to show).
 */
export function zoomIn(current: number, autoRangeKm: number): number {
  const ref = isAutoRange(current) ? autoRangeKm : current;
  let smaller = -Infinity;
  for (const s of STOPS) if (s < ref && s > smaller) smaller = s;
  return smaller === -Infinity ? current : smaller;
}

/**
 * Range to zoom *out* to (a larger km ring). Mirror of {@link zoomIn}: returns the smallest stop
 * strictly above the reference range, or `current` unchanged when already at the outermost stop.
 */
export function zoomOut(current: number, autoRangeKm: number): number {
  const ref = isAutoRange(current) ? autoRangeKm : current;
  for (const s of STOPS) if (s > ref) return s;
  return current;
}
