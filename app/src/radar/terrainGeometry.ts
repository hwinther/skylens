/**
 * Terrain geometry for the tilted Radar — pure, no RN imports. Built once per grid / range / observer
 * offset (never per frame); a tilt change only re-projects it (see terrainPaths.ts). All coordinates are
 * km east/north of the observer, clipped to the scope disc; heights are metres.
 *
 *  - Land: the land cells as row runs (rectangles), a faint tint that sets land off from the sea.
 *  - Coastline: the sea → land iso-line (marching squares), the brightest line, at sea level.
 *  - Ridges: east–west height profiles across the land every few km, north to south. Drawn at their
 *    height, each filled down to sea level so it hides the ones behind it, they read as an oblique relief
 *    view once the scope tilts — the scan-line look of an old vector display, mountains rising as the
 *    profiles bunch up and peak. Over the sea there is nothing, so the coastline and fjords stay clear.
 *
 * Everything is capped (rows, points, rectangles), so a dense fjord coast at a long range stays cheap.
 */

import { clipLineToCircle, contourLines, type FlatLine } from "./contours";
import type { TerrainGrid } from "./terrainGrid";

/** Sea is 0 and land at least 10 m, so the coastline is the 5 m iso-line. */
export const COAST_LEVEL_M = 5;

/** Ridge rows across the scope's diameter, at most (fewer when the grid is coarser than that). */
export const MAX_RIDGE_ROWS = 56;
/** Samples along the widest ridge row, at most. */
export const MAX_RIDGE_SAMPLES = 128;
export const MAX_RIDGE_POINTS = 7000;
export const MAX_COAST_POINTS = 4000;
export const MAX_LAND_RECTS = 2500;

/** Closed coast loops (islets) need this many points to be kept: smaller ones are grid specks. */
const MIN_COAST_POINTS = 4;

/** Sub-rows / sub-columns per grid cell for the land tint (half-cell steps follow the coast closer). */
const LAND_SUBDIVISIONS = 2;

export interface RidgeRow {
  /** The row's northing (km). */
  yKm: number;
  /** Runs over land, each flat [x0, h0, x1, h1, …] (km, m), west → east. */
  runs: number[][];
}

export interface TerrainGeometry {
  /** Land tint rectangles, 4 numbers each: west, east, north, south edge (km). */
  land: number[];
  /** Coastline polylines, flat [x0, y0, …] (km). */
  coast: FlatLine[];
  /** Height profiles, north → south (the drawing order: nearer rows cover farther ones). */
  ridges: RidgeRow[];
  /** Highest height within the scope disc (m): picks the relief exaggeration. */
  maxM: number;
  /** True when anything was dropped or thinned to stay within the caps. */
  capped: boolean;
}

export interface GeometryOptions {
  /** Ridge rows across the diameter (default MAX_RIDGE_ROWS); see ridgeRowsFor. */
  ridgeRows?: number;
  maxRidgePoints?: number;
  maxCoastPoints?: number;
  maxLandRects?: number;
}

/**
 * Builds the geometry for `grid`, whose centre sits at `offset` (km) from the observer, clipped to a
 * scope of `rangeKm`.
 */
export function buildTerrainGeometry(
  grid: TerrainGrid,
  offset: { dx: number; dy: number },
  rangeKm: number,
  opts: GeometryOptions = {},
): TerrainGeometry {
  const n = grid.size;
  const half = (n - 1) / 2;
  const cell = grid.cellKm;
  let capped = false;

  // Coastline on the raw grid, specks dropped, clipped to the disc, thinned to the cap.
  const toKm = (line: FlatLine): FlatLine => {
    const out = new Array<number>(line.length);
    for (let i = 0; i < line.length; i += 2) {
      out[i] = offset.dx + (line[i] - half) * cell;
      out[i + 1] = offset.dy + (half - line[i + 1]) * cell;
    }
    return out;
  };
  let coast = contourLines(grid.heights, n, COAST_LEVEL_M)
    .filter((l) => l.length / 2 >= MIN_COAST_POINTS || !isClosed(l))
    .flatMap((l) => clipLineToCircle(toKm(l), rangeKm));
  const coastPoints = coast.reduce((s, l) => s + l.length / 2, 0);
  const maxCoast = opts.maxCoastPoints ?? MAX_COAST_POINTS;
  if (coastPoints > maxCoast) {
    capped = true;
    const stride = Math.ceil(coastPoints / maxCoast);
    coast = coast.map((l) => thin(l, stride)).filter((l) => l.length >= 4);
  }

  // Land tint: half-cell runs, or whole cells if that would blow the cap.
  const maxRects = opts.maxLandRects ?? MAX_LAND_RECTS;
  let land = landRuns(grid.heights, n, LAND_SUBDIVISIONS, cell, offset, rangeKm);
  if (land.length / 4 > maxRects) land = landRuns(grid.heights, n, 1, cell, offset, rangeKm);
  if (land.length / 4 > maxRects) {
    capped = true;
    land = land.slice(0, maxRects * 4);
  }

  // Ridges on a lightly smoothed copy (a 1 km grid in rough terrain is spiky), land tested on the raw grid.
  const smooth = smoothLand(grid.heights, n);
  const rows = Math.min(MAX_RIDGE_ROWS, Math.max(2, Math.round(opts.ridgeRows ?? MAX_RIDGE_ROWS)));
  const spacing = Math.max(cell, (2 * rangeKm) / rows);
  const step = Math.max(cell * 0.75, (2 * rangeKm) / MAX_RIDGE_SAMPLES);
  let ridges: RidgeRow[] = [];
  let points = 0;
  for (let y = rangeKm - spacing / 2; y > -rangeKm; y -= spacing) {
    const xLim = Math.sqrt(rangeKm * rangeKm - y * y);
    const count = Math.max(2, Math.ceil((2 * xLim) / step) + 1);
    const runs: number[][] = [];
    let run: number[] | null = null;
    for (let i = 0; i < count; i++) {
      const x = -xLim + (2 * xLim * i) / (count - 1);
      const isLand = sample(grid.heights, n, cell, offset, x, y) >= COAST_LEVEL_M;
      if (isLand) {
        if (!run) run = [];
        run.push(x, Math.max(0, sample(smooth, n, cell, offset, x, y)));
      } else if (run) {
        if (run.length >= 4) runs.push(run);
        run = null;
      }
    }
    if (run && run.length >= 4) runs.push(run);
    if (runs.length) {
      ridges.push({ yKm: y, runs });
      points += runs.reduce((s, r) => s + r.length / 2, 0);
    }
  }
  const maxRidge = opts.maxRidgePoints ?? MAX_RIDGE_POINTS;
  while (points > maxRidge && ridges.length > 1) {
    // Every other row: coarser, but evenly so (no band of missing relief).
    capped = true;
    ridges = ridges.filter((_, i) => i % 2 === 0);
    points = ridges.reduce((s, row) => s + row.runs.reduce((a, r) => a + r.length / 2, 0), 0);
  }

  return { land, coast, ridges, maxM: maxInDisc(grid, offset, rangeKm), capped };
}

/**
 * Ridge rows for a scope of radius `radiusPx`: about one per 4.5 px of radius, so at full tilt (where
 * the disc is foreshortened to half its height) neighbouring profiles stay a few pixels apart instead of
 * merging into a smear on a phone. Snapped to steps of 4 so small layout changes don't rebuild it.
 */
export function ridgeRowsFor(radiusPx: number): number {
  const rows = Math.round(radiusPx / 4.5 / 4) * 4;
  return Math.min(MAX_RIDGE_ROWS, Math.max(16, rows));
}

/** Bilinear height at a point (km, observer frame) of an n × n grid centred at `offset`; 0 off the grid. */
function sample(
  h: ArrayLike<number>,
  n: number,
  cell: number,
  offset: { dx: number; dy: number },
  xKm: number,
  yKm: number,
): number {
  const half = (n - 1) / 2;
  const gc = (xKm - offset.dx) / cell + half;
  const gr = half - (yKm - offset.dy) / cell;
  if (!(gc >= 0 && gr >= 0 && gc <= n - 1 && gr <= n - 1)) return 0;
  const r0 = Math.min(Math.floor(gr), n - 2);
  const c0 = Math.min(Math.floor(gc), n - 2);
  const fr = gr - r0;
  const fc = gc - c0;
  const top = h[r0 * n + c0] * (1 - fc) + h[r0 * n + c0 + 1] * fc;
  const bottom = h[(r0 + 1) * n + c0] * (1 - fc) + h[(r0 + 1) * n + c0 + 1] * fc;
  return top * (1 - fr) + bottom * fr;
}

/**
 * Runs of land samples as rectangles (west, east, north, south km), sampling the grid bilinearly `k`
 * times per cell in both directions, clipped to the disc at each row's centre.
 */
function landRuns(
  src: ArrayLike<number>,
  n: number,
  k: number,
  cell: number,
  offset: { dx: number; dy: number },
  rangeKm: number,
): number[] {
  const out: number[] = [];
  const m = (n - 1) * k + 1;
  const stepKm = cell / k;
  const half = (n - 1) / 2;
  const value = (gr: number, gc: number) => {
    const r0 = Math.min(Math.floor(gr), n - 2);
    const c0 = Math.min(Math.floor(gc), n - 2);
    const fr = gr - r0;
    const fc = gc - c0;
    const top = src[r0 * n + c0] * (1 - fc) + src[r0 * n + c0 + 1] * fc;
    const bottom = src[(r0 + 1) * n + c0] * (1 - fc) + src[(r0 + 1) * n + c0 + 1] * fc;
    return top * (1 - fr) + bottom * fr;
  };
  for (let r = 0; r < m; r++) {
    const gr = r / k;
    const yc = offset.dy + (half - gr) * cell;
    if (Math.abs(yc) >= rangeKm) continue;
    const xLim = Math.sqrt(rangeKm * rangeKm - yc * yc);
    let c = 0;
    while (c < m) {
      if (value(gr, c / k) < COAST_LEVEL_M) {
        c++;
        continue;
      }
      const start = c;
      while (c < m && value(gr, c / k) >= COAST_LEVEL_M) c++;
      const west = Math.max(-xLim, offset.dx + (start / k - half) * cell - stepKm / 2);
      const east = Math.min(xLim, offset.dx + ((c - 1) / k - half) * cell + stepKm / 2);
      if (east > west) out.push(west, east, yc + stepKm / 2, yc - stepKm / 2);
    }
  }
  return out;
}

/** Highest cell within the scope disc. */
function maxInDisc(g: TerrainGrid, offset: { dx: number; dy: number }, rangeKm: number): number {
  const n = g.size;
  const half = (n - 1) / 2;
  let m = 0;
  for (let r = 0; r < n; r++) {
    const y = offset.dy + (half - r) * g.cellKm;
    for (let c = 0; c < n; c++) {
      const v = g.heights[r * n + c];
      if (v <= m) continue;
      const x = offset.dx + (c - half) * g.cellKm;
      if (x * x + y * y <= rangeKm * rangeKm) m = v;
    }
  }
  return m;
}

function isClosed(l: FlatLine): boolean {
  return l.length >= 4 && l[0] === l[l.length - 2] && l[1] === l[l.length - 1];
}

/**
 * A 3 × 3 box blur over land cells only (sea stays 0 and doesn't drag the coast down), so the profiles
 * read as slopes rather than grid noise.
 */
export function smoothLand(h: ArrayLike<number>, n: number): Float32Array {
  const out = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!(h[r * n + c] > 0)) continue;
      let sum = 0;
      let k = 0;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= n) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= n) continue;
          const v = h[rr * n + cc];
          if (v > 0) {
            sum += v;
            k++;
          }
        }
      }
      out[r * n + c] = sum / k;
    }
  }
  return out;
}

/** Keeps every `stride`-th point of a polyline, always keeping both ends. */
function thin(line: FlatLine, stride: number): FlatLine {
  if (stride <= 1 || line.length <= 4) return line;
  const out: FlatLine = [];
  const last = line.length / 2 - 1;
  for (let i = 0; i <= last; i++) {
    if (i % stride === 0 || i === last) out.push(line[2 * i], line[2 * i + 1]);
  }
  return out;
}
