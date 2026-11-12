/**
 * Size-aware, cross-kind declutter for the AR overlay's non-aircraft labels.
 *
 * `declutter` (declutter.ts) treats every label as a 28 px tall slot in a 120 px column and runs once
 * per kind. That is right for the single-line spacing it was tuned for, but two-line chips (a planet's
 * name + magnitude, a satellite's name + elevation) are ~38 px tall, so a label pushed one 28 px step
 * still overlaps the one above it by ~10 px (the Jupiter/Mars case). And because each kind ran its own
 * pass, a planet could sit on a satellite, a radio source or an aircraft label without either moving.
 *
 * `declutterLayers` places labels as boxes instead:
 *  - each label carries its own estimated width/height; its box starts LABEL_ANCHOR_INSET_PX up and left
 *    of the anchor, matching the chips' `translate(-6, -6)`, and extends right and down from there;
 *  - `obstacles` are boxes that are already placed and never move (the aircraft labels, which keep
 *    their own placement untouched), so no sky label is drawn over them;
 *  - layers are placed in order, so an earlier layer (planets) is never pushed by a later one
 *    (satellites, radio, airports); within a layer, higher priority keeps its spot, as in `declutter`;
 *  - a colliding label snaps to just below the lowest box it hits (plus LABEL_GAP_PX) and keeps its
 *    anchor x and anchor y, so the caller draws the usual leader line back to the true point;
 *  - anything pushed further than `maxPushPx` collapses into a per-layer "+N" chip, as in `declutter`.
 *
 * Coordinates are pixels, y down. Must import nothing from react-native / expo / react.
 */

import {
  buildClusters,
  type ClusterChip,
  type DeclutterResult,
  type PlacedLabel,
  type ScreenLabel,
} from "./declutter";

/** The chips are drawn with `translate(-6, -6)`: the box's top-left sits this far up/left of the anchor. */
export const LABEL_ANCHOR_INSET_PX = 6;
/** Breathing room kept between a pushed label and the box above it. */
export const LABEL_GAP_PX = 2;

/** Estimated rendered heights (px): two-line chips (title + sub line) and single-line ones. */
export const TWO_LINE_LABEL_HEIGHT_PX = 38;
export const ONE_LINE_LABEL_HEIGHT_PX = 23;
/** Airport chips use a smaller font and tighter padding. */
export const AIRPORT_LABEL_HEIGHT_PX = 20;
/** Obstacle box used for an aircraft label (two lines, callsign + "FL240 20.9 km"). */
export const AIRCRAFT_LABEL_BOX = { width: 120, height: TWO_LINE_LABEL_HEIGHT_PX } as const;

export interface LabelSize {
  width: number;
  height: number;
}

/** A label to place, with the size of the chip it renders. */
export interface SizedLabel extends ScreenLabel, LabelSize {}

/** An already-placed box, given by its anchor (x, y) like a label; it never moves. */
export interface LabelBox extends LabelSize {
  x: number;
  y: number;
}

export interface LayeredDeclutterConfig {
  /** Max downward push before a label collapses into its layer's "+N" chip. */
  maxPushPx: number;
  /** Column width used to group collapsed labels into chips (as in `declutter`). */
  columnWidthPx: number;
}

export const DEFAULT_LAYERED_DECLUTTER_CONFIG: LayeredDeclutterConfig = {
  // Room for four stacked two-line chips below the anchor before clustering.
  maxPushPx: 4 * (TWO_LINE_LABEL_HEIGHT_PX + LABEL_GAP_PX),
  columnWidthPx: 120,
};

export interface WidthEstimate {
  /** Average glyph advance in px. */
  charPx?: number;
  /** Fixed chrome: horizontal padding, border and any leading icon. */
  chromePx?: number;
  /** The chip's `maxWidth` (text beyond it is ellipsized). */
  maxWidth: number;
}

/**
 * Rough chip width from its longest line. Text isn't measured per frame (that would need a layout
 * pass), so this errs slightly wide: a little extra stacking beats an overlap.
 */
export function estimateLabelWidth(
  lines: readonly (string | null | undefined)[],
  { charPx = 7, chromePx = 30, maxWidth }: WidthEstimate,
): number {
  let longest = 0;
  for (const l of lines) if (l && l.length > longest) longest = l.length;
  return Math.min(maxWidth, Math.ceil(longest * charPx + chromePx));
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function rectAt(x: number, y: number, size: LabelSize): Rect {
  const left = x - LABEL_ANCHOR_INSET_PX;
  const top = y - LABEL_ANCHOR_INSET_PX;
  return { left, top, right: left + size.width, bottom: top + size.height };
}

/** Overlap test with LABEL_GAP_PX of vertical clearance required. */
function collides(a: Rect, b: Rect): boolean {
  return (
    a.left < b.right &&
    b.left < a.right &&
    a.top < b.bottom + LABEL_GAP_PX &&
    b.top < a.bottom + LABEL_GAP_PX
  );
}

/**
 * Place several kinds of labels against each other and against fixed obstacles.
 * Returns one `DeclutterResult` per input layer, in the same order.
 */
export function declutterLayers(
  layers: readonly (readonly SizedLabel[])[],
  obstacles: readonly LabelBox[] = [],
  config: LayeredDeclutterConfig = DEFAULT_LAYERED_DECLUTTER_CONFIG,
): DeclutterResult[] {
  const boxes: Rect[] = obstacles.map((o) => rectAt(o.x, o.y, o));
  const results: DeclutterResult[] = [];

  for (const layer of layers) {
    const sorted = [...layer].sort(
      (a, b) => b.priority - a.priority || a.y - b.y || a.id.localeCompare(b.id),
    );
    const placed: PlacedLabel[] = [];
    const collapsed: ScreenLabel[] = [];

    for (const label of sorted) {
      let y = label.y;
      for (;;) {
        const r = rectAt(label.x, y, label);
        let lowestBottom = -Infinity;
        for (const b of boxes) if (collides(r, b)) lowestBottom = Math.max(lowestBottom, b.bottom);
        if (lowestBottom === -Infinity) break;
        // Snap the top to just below the lowest box hit. Bail if y fails to advance (floating-point
        // rounding or a non-finite anchor) so the loop can never spin; see the same guard in declutter.
        const next = lowestBottom + LABEL_GAP_PX + LABEL_ANCHOR_INSET_PX;
        if (!(next > y)) break;
        y = next;
      }

      if (y - label.y > config.maxPushPx) {
        collapsed.push(label);
      } else {
        placed.push({ id: label.id, x: label.x, y, anchorY: label.y });
        boxes.push(rectAt(label.x, y, label));
      }
    }

    const clusters: ClusterChip[] = buildClusters(collapsed, config.columnWidthPx);
    results.push({ placed, clusters });
  }

  return results;
}
