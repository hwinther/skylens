/**
 * Pure-TypeScript label declutter.
 *
 * When several aircraft project close together, their labels overlap. We run a
 * greedy pass: sort by screen y (top → down), and for each label that would collide
 * vertically with an already-placed one, push it down in fixed 28 px steps until it
 * clears. If a label cannot be placed within a reasonable band (too many stacked at
 * one spot), the extras collapse into a single "+N" cluster chip anchored at the
 * group's centroid, so the sky stays readable.
 *
 * Coordinates here are in *pixels* (screen space), y increasing downward.
 *
 * Must import nothing from react-native / expo / react.
 */

export const LABEL_STEP_PX = 28;

export interface ScreenLabel {
  /** Stable id (aircraft hex). */
  id: string;
  /** Anchor x in pixels (the projected point). */
  x: number;
  /** Desired y in pixels (the projected point). */
  y: number;
  /** Priority — higher wins the un-pushed spot (e.g. closer / lower slant range). */
  priority: number;
}

export interface PlacedLabel {
  id: string;
  x: number;
  /** Final, decluttered y in pixels. */
  y: number;
  /** The original anchor y, so a leader line can be drawn back to the point. */
  anchorY: number;
}

export interface ClusterChip {
  /** Centroid x of the collapsed labels. */
  x: number;
  /** Centroid y of the collapsed labels. */
  y: number;
  /** How many labels were collapsed into this chip. */
  count: number;
  /** Ids that were collapsed (for tap-to-expand). */
  ids: string[];
}

export interface DeclutterConfig {
  /** Vertical push step in pixels. */
  stepPx: number;
  /** Two labels closer than this in x are considered the same column for collision. */
  columnWidthPx: number;
  /** Max total downward push before a label is collapsed into a cluster chip. */
  maxPushPx: number;
}

export const DEFAULT_DECLUTTER_CONFIG: DeclutterConfig = {
  stepPx: LABEL_STEP_PX,
  columnWidthPx: 120,
  maxPushPx: LABEL_STEP_PX * 6, // 168 px = up to 6 stacked labels before clustering
};

export interface DeclutterResult {
  placed: PlacedLabel[];
  clusters: ClusterChip[];
}

/**
 * Greedy vertical declutter. Higher-priority labels keep their spot; lower-priority
 * ones in the same x-column are pushed down in `stepPx` increments. Anything that
 * would exceed `maxPushPx` is collapsed into a cluster chip with its column-mates.
 */
export function declutter(
  labels: ScreenLabel[],
  config: DeclutterConfig = DEFAULT_DECLUTTER_CONFIG,
): DeclutterResult {
  const { stepPx, columnWidthPx, maxPushPx } = config;

  // Place highest priority first; tie-break by y (top-most) then id for determinism.
  const sorted = [...labels].sort(
    (a, b) => b.priority - a.priority || a.y - b.y || a.id.localeCompare(b.id),
  );

  const placed: PlacedLabel[] = [];
  const collapsed: ScreenLabel[] = [];

  for (const label of sorted) {
    let y = label.y;

    // Push down while colliding with an already-placed label in the same column.
    // Collision = within one step vertically and within columnWidth horizontally.
    // On collision we *snap* to exactly one step below the lowest colliding label
    // so stacked labels sit on a clean stepPx grid regardless of sub-pixel anchors.
    for (;;) {
      let lowestCollision = -Infinity;
      for (const p of placed) {
        if (Math.abs(p.x - label.x) < columnWidthPx && Math.abs(p.y - y) < stepPx) {
          lowestCollision = Math.max(lowestCollision, p.y);
        }
      }
      if (lowestCollision === -Infinity) break;
      // Snap to exactly one step below the lowest colliding label. We must guarantee forward
      // progress: `lowestCollision + stepPx` is mathematically > y, but with real fractional
      // coordinates floating-point rounding can make the recomputed gap read as *just under*
      // stepPx, so the label "collides with itself" and y never advances — an infinite loop that
      // hard-freezes the tab once a few ships stack in one horizon-band column. Bail the moment y
      // fails to strictly increase (also covers a non-finite y). The slot is clear either way.
      const next = lowestCollision + stepPx;
      if (!(next > y)) break;
      y = next;
    }

    // Total downward displacement from the original anchor decides clustering.
    if (y - label.y > maxPushPx) {
      collapsed.push(label);
    } else {
      placed.push({ id: label.id, x: label.x, y, anchorY: label.y });
    }
  }

  const clusters = buildClusters(collapsed, columnWidthPx);
  return { placed, clusters };
}

/** Group collapsed labels into cluster chips by x-column proximity. */
function buildClusters(collapsed: ScreenLabel[], columnWidthPx: number): ClusterChip[] {
  const chips: ClusterChip[] = [];
  const remaining = [...collapsed].sort((a, b) => a.x - b.x);

  while (remaining.length > 0) {
    const seed = remaining.shift() as ScreenLabel;
    const members = [seed];
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (Math.abs(remaining[i].x - seed.x) < columnWidthPx) {
        members.push(remaining[i]);
        remaining.splice(i, 1);
      }
    }
    const count = members.length;
    const x = members.reduce((s, m) => s + m.x, 0) / count;
    const y = members.reduce((s, m) => s + m.y, 0) / count;
    chips.push({ x, y, count, ids: members.map((m) => m.id) });
  }

  return chips;
}
