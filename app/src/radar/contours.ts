/**
 * Marching squares on a square height grid — pure, no RN imports.
 *
 * {@link contourLines} traces the iso-line of one level through an n × n row-major grid (row 0 first) and
 * chains the per-cell segments into polylines, in grid coordinates (x = column, y = row, fractional).
 * Saddle cells are disambiguated by the cell-centre average. Lines that reach the grid edge stay open;
 * the rest close (first point repeated at the end).
 */

/** A polyline as a flat [x0, y0, x1, y1, …] array. */
export type FlatLine = number[];

// Edges of a cell, in the order of the lookup table below.
const TOP = 0;
const RIGHT = 1;
const BOTTOM = 2;
const LEFT = 3;

/**
 * Segment table by case index (tl·8 + tr·4 + br·2 + bl·1, a corner counting when ≥ level). Saddles (5, 10)
 * have two entries: [centre below level, centre at/above level].
 */
const SEGMENTS: (readonly (readonly [number, number])[])[] = [
  [],
  [[LEFT, BOTTOM]],
  [[BOTTOM, RIGHT]],
  [[LEFT, RIGHT]],
  [[TOP, RIGHT]],
  [], // 5: saddle
  [[TOP, BOTTOM]],
  [[LEFT, TOP]],
  [[LEFT, TOP]],
  [[TOP, BOTTOM]],
  [], // 10: saddle
  [[TOP, RIGHT]],
  [[LEFT, RIGHT]],
  [[RIGHT, BOTTOM]],
  [[LEFT, BOTTOM]],
  [],
];
const SADDLE_5_LOW = [
  [TOP, RIGHT],
  [LEFT, BOTTOM],
] as const;
const SADDLE_5_HIGH = [
  [LEFT, TOP],
  [RIGHT, BOTTOM],
] as const;
const SADDLE_10_LOW = [
  [LEFT, TOP],
  [BOTTOM, RIGHT],
] as const;
const SADDLE_10_HIGH = [
  [TOP, RIGHT],
  [LEFT, BOTTOM],
] as const;

/**
 * The iso-lines of `level` through `values` (n × n, row-major). Returned polylines are in grid
 * coordinates; adjacent cells share the exact crossing point, so chained lines are seamless.
 */
export function contourLines(values: ArrayLike<number>, n: number, level: number): FlatLine[] {
  if (n < 2 || values.length < n * n) return [];
  const hEdges = n * (n - 1); // horizontal edges: n rows × (n−1)
  // Edge id → crossing point; segment endpoints are edge ids.
  const px = new Map<number, number>();
  const py = new Map<number, number>();
  const segA: number[] = [];
  const segB: number[] = [];

  const crossing = (id: number, x0: number, y0: number, v0: number, x1: number, y1: number, v1: number) => {
    if (px.has(id)) return;
    const t = v1 === v0 ? 0.5 : (level - v0) / (v1 - v0);
    px.set(id, x0 + (x1 - x0) * t);
    py.set(id, y0 + (y1 - y0) * t);
  };

  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const tl = values[r * n + c];
      const tr = values[r * n + c + 1];
      const br = values[(r + 1) * n + c + 1];
      const bl = values[(r + 1) * n + c];
      const idx = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      let segs: readonly (readonly [number, number])[];
      if (idx === 5 || idx === 10) {
        const high = (tl + tr + br + bl) / 4 >= level;
        segs = idx === 5 ? (high ? SADDLE_5_HIGH : SADDLE_5_LOW) : high ? SADDLE_10_HIGH : SADDLE_10_LOW;
      } else {
        segs = SEGMENTS[idx];
      }
      const ids = [r * (n - 1) + c, hEdges + r * n + c + 1, (r + 1) * (n - 1) + c, hEdges + r * n + c];
      for (const [ea, eb] of segs) {
        for (const e of [ea, eb]) {
          const id = ids[e];
          if (e === TOP) crossing(id, c, r, tl, c + 1, r, tr);
          else if (e === RIGHT) crossing(id, c + 1, r, tr, c + 1, r + 1, br);
          else if (e === BOTTOM) crossing(id, c, r + 1, bl, c + 1, r + 1, br);
          else crossing(id, c, r, tl, c, r + 1, bl);
        }
        segA.push(ids[ea]);
        segB.push(ids[eb]);
      }
    }
  }
  return chain(segA, segB, px, py);
}

/** Joins segments sharing an edge id into polylines: open chains first (from a dangling end), then loops. */
function chain(segA: number[], segB: number[], px: Map<number, number>, py: Map<number, number>): FlatLine[] {
  const bySeg = new Map<number, number[]>();
  const add = (id: number, s: number) => {
    const list = bySeg.get(id);
    if (list) list.push(s);
    else bySeg.set(id, [s]);
  };
  for (let s = 0; s < segA.length; s++) {
    add(segA[s], s);
    add(segB[s], s);
  }
  const used = new Uint8Array(segA.length);
  const lines: FlatLine[] = [];

  const walk = (startSeg: number, startId: number) => {
    const line: FlatLine = [px.get(startId)!, py.get(startId)!];
    let seg = startSeg;
    let at = startId;
    while (seg >= 0 && !used[seg]) {
      used[seg] = 1;
      const next = segA[seg] === at ? segB[seg] : segA[seg];
      line.push(px.get(next)!, py.get(next)!);
      at = next;
      seg = -1;
      for (const s of bySeg.get(at) ?? []) {
        if (!used[s]) {
          seg = s;
          break;
        }
      }
    }
    lines.push(line);
  };

  // Open lines start at an edge id used by a single segment (the grid border).
  for (const [id, segs] of bySeg) {
    if (segs.length === 1 && !used[segs[0]]) walk(segs[0], id);
  }
  for (let s = 0; s < segA.length; s++) {
    if (!used[s]) walk(s, segA[s]);
  }
  return lines;
}

/**
 * Clips a polyline (flat, any units) to a circle of radius `r` around the origin, splitting it where it
 * leaves and re-enters; the cut points sit exactly on the circle. Pieces shorter than two points drop.
 */
export function clipLineToCircle(line: FlatLine, r: number): FlatLine[] {
  const out: FlatLine[] = [];
  const r2 = r * r;
  let cur: FlatLine | null = null;
  const inside = (x: number, y: number) => x * x + y * y <= r2;
  for (let i = 0; i + 1 < line.length; i += 2) {
    const x = line[i];
    const y = line[i + 1];
    const isIn = inside(x, y);
    if (i === 0) {
      if (isIn) cur = [x, y];
      continue;
    }
    const x0 = line[i - 2];
    const y0 = line[i - 1];
    const wasIn = inside(x0, y0);
    if (wasIn && isIn) {
      cur!.push(x, y);
    } else if (wasIn && !isIn) {
      const [t] = circleHits(x0, y0, x, y, r);
      cur!.push(x0 + (x - x0) * t, y0 + (y - y0) * t);
      if (cur!.length >= 4) out.push(cur!);
      cur = null;
    } else if (!wasIn && isIn) {
      const hits = circleHits(x0, y0, x, y, r);
      const t = hits[hits.length - 1];
      cur = [x0 + (x - x0) * t, y0 + (y - y0) * t, x, y];
    } else {
      // Both outside: the segment may still cut through the disc.
      const hits = circleHits(x0, y0, x, y, r);
      if (hits.length === 2) {
        out.push([x0 + (x - x0) * hits[0], y0 + (y - y0) * hits[0], x0 + (x - x0) * hits[1], y0 + (y - y0) * hits[1]]);
      }
    }
  }
  if (cur && cur.length >= 4) out.push(cur);
  return out;
}

/** Parameters t ∈ [0, 1] (ascending) where segment p0→p1 crosses the circle |p| = r. */
function circleHits(x0: number, y0: number, x1: number, y1: number, r: number): number[] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const a = dx * dx + dy * dy;
  if (a === 0) return [0];
  const b = 2 * (x0 * dx + y0 * dy);
  const c = x0 * x0 + y0 * y0 - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const ts = [(-b - sq) / (2 * a), (-b + sq) / (2 * a)].filter((t) => t >= 0 && t <= 1);
  return ts.length ? ts : [Math.min(1, Math.max(0, -b / (2 * a)))];
}
