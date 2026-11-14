/**
 * The Radar's terrain grid (GET /api/terrain, or the bundled demo sample) — pure helpers, no RN imports.
 *
 * A square grid of `size` × `size` heights (m, 0 = sea) every `cellKm`, row-major from the north-west
 * corner, centred on the point it was fetched for: cell (row, col) is `(col − half)·cellKm` east and
 * `(half − row)·cellKm` north of that centre, where half = (size − 1) / 2. The observer may have moved a
 * little since the fetch, so geometry is built relative to an offset: the grid centre's position in the
 * observer's km frame (see {@link gridOffsetKm}).
 */

import { relativePosition } from "@/components/webmap/relative";
import { polarToKm } from "./projection";

export interface TerrainGrid {
  /** Centre the grid was sampled around. */
  lat: number;
  lon: number;
  radiusKm: number;
  cellKm: number;
  size: number;
  heights: ArrayLike<number>;
  attribution: string;
}

/** The API/demo payload shape (fields optional, as the generated schema has them). */
export interface TerrainPayload {
  lat?: number;
  lon?: number;
  radiusKm?: number;
  cellKm?: number;
  size?: number;
  heights?: number[] | null;
  attribution?: string | null;
}

/** Credit for ETOPO 2022 (a US Government work): shown wherever the relief is drawn. */
export const TERRAIN_ATTRIBUTION = "ETOPO 2022 (NOAA NCEI)";

/** Largest grid side accepted (the server caps at 129). */
export const MAX_GRID_SIZE = 257;

/** Validates a payload into a grid; null when it is empty (DB unavailable) or malformed. */
export function toTerrainGrid(p: TerrainPayload | null | undefined): TerrainGrid | null {
  if (!p) return null;
  const { lat, lon, radiusKm, cellKm, size, heights } = p;
  if (
    typeof lat !== "number" ||
    typeof lon !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    typeof cellKm !== "number" ||
    !(cellKm > 0) ||
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size < 2 ||
    size > MAX_GRID_SIZE ||
    !Array.isArray(heights) ||
    heights.length !== size * size
  ) {
    return null;
  }
  const h = new Float32Array(heights.length);
  for (let i = 0; i < heights.length; i++) {
    const v = heights[i];
    h[i] = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  }
  return {
    lat,
    lon,
    radiusKm: typeof radiusKm === "number" && radiusKm > 0 ? radiusKm : ((size - 1) / 2) * cellKm,
    cellKm,
    size,
    heights: h,
    attribution: p.attribution || TERRAIN_ATTRIBUTION,
  };
}

/** Highest height in the grid (m). */
export function gridMaxM(g: TerrainGrid): number {
  let m = 0;
  for (let i = 0; i < g.heights.length; i++) if (g.heights[i] > m) m = g.heights[i];
  return m;
}

/** Where the grid's centre sits in the observer's frame (km east, km north). */
export function gridOffsetKm(g: TerrainGrid, observer: { lat: number; lon: number }): { dx: number; dy: number } {
  if (g.lat === observer.lat && g.lon === observer.lon) return { dx: 0, dy: 0 };
  const rel = relativePosition(observer, g.lat, g.lon);
  const { xKm, yKm } = polarToKm(rel.distanceKm, rel.bearingDeg);
  return { dx: xKm, dy: yKm };
}

/**
 * Height (m) at a point in the observer's km frame, bilinear between the four surrounding cells; 0 off
 * the grid. Used to set blips on the relief.
 */
export function heightAtKm(g: TerrainGrid, offset: { dx: number; dy: number }, xKm: number, yKm: number): number {
  const half = (g.size - 1) / 2;
  const col = (xKm - offset.dx) / g.cellKm + half;
  const row = half - (yKm - offset.dy) / g.cellKm;
  if (!(col >= 0 && row >= 0 && col <= g.size - 1 && row <= g.size - 1)) return 0;
  const c0 = Math.min(Math.floor(col), g.size - 2);
  const r0 = Math.min(Math.floor(row), g.size - 2);
  const fc = col - c0;
  const fr = row - r0;
  const n = g.size;
  const h = g.heights;
  const top = h[r0 * n + c0] * (1 - fc) + h[r0 * n + c0 + 1] * fc;
  const bottom = h[(r0 + 1) * n + c0] * (1 - fc) + h[(r0 + 1) * n + c0 + 1] * fc;
  return top * (1 - fr) + bottom * fr;
}
