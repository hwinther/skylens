/**
 * When the Radar's terrain grid is (re)fetched — pure, no RN imports. The radar asks for a grid a bit
 * larger than its range, then keeps it while the observer moves or the range changes within what it
 * covers; it refetches only when the scope would run off the grid's edge, or when the range has shrunk
 * so much that a finer grid is worth it.
 */

import { relativePosition } from "@/components/webmap/relative";

/** Radius ladder (km) the requests snap to, so nearby ranges share a grid (and the cache). */
const RADII = [10, 20, 35, 50, 75, 100, 150, 250, 350, 500] as const;

/** Headroom over the range, so a little movement doesn't run off the grid. */
const HEADROOM = 1.2;

/** A grid this many times larger than needed is too coarse for the range: fetch a finer one. */
const TOO_COARSE = 2.5;

/** The grid radius (km) to request for a scope of `rangeKm`. */
export function terrainRadiusFor(rangeKm: number): number {
  const want = Math.max(rangeKm, 1) * HEADROOM;
  return RADII.find((r) => r >= want) ?? RADII[RADII.length - 1];
}

export interface FetchedArea {
  lat: number;
  lon: number;
  radiusKm: number;
}

/** Moving this fraction of the grid radius away from its centre re-centres it. */
const RECENTRE = 0.2;

/**
 * True when the grid fetched for `fetched` no longer serves a scope of `rangeKm` around `observer`: none
 * yet, the range now wants a larger grid (zoomed out), the observer has moved far enough from its centre
 * for the scope to near its edge, or it is too coarse for the (zoomed-in) range.
 */
export function shouldRefetchTerrain(
  fetched: FetchedArea | null,
  observer: { lat: number; lon: number },
  rangeKm: number,
): boolean {
  if (!fetched) return true;
  const want = terrainRadiusFor(rangeKm);
  if (want > fetched.radiusKm + 1e-9) return true;
  if (fetched.radiusKm > want * TOO_COARSE) return true;
  return relativePosition(observer, fetched.lat, fetched.lon).distanceKm > fetched.radiusKm * RECENTRE;
}

/** Request centre, rounded to 0.01° (~1 km) so small GPS jitter hits the same cache entry. */
export function roundCentre(v: number): number {
  return Math.round(v * 100) / 100;
}
