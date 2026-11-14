/**
 * The tilted Radar's terrain grid. Live mode fetches GET /api/terrain for the observer's area, sized to
 * the radar range (src/radar/terrainFetch.ts), and keeps it while the observer moves or the range changes
 * within what it covers — the geometry is built locally, never one request per frame. Recent grids are
 * cached (module scope), so flipping between ranges doesn't refetch. Demo mode has no API: it serves a
 * bundled sample of the real grid around the demo home (src/mock/demo-terrain.json), kept apart from live
 * data.
 *
 * Gated like every API caller (useApiAllowed). Lazy: nothing is fetched until `enabled` (the radar has
 * been tilted), so the flat radar costs nothing extra.
 */

import { useEffect, useState } from "react";
import type { ApiClient } from "@/api/client";
import { useApiAllowed } from "@/state/authStore";
import { roundCentre, shouldRefetchTerrain, terrainRadiusFor, type FetchedArea } from "@/radar/terrainFetch";
import { toTerrainGrid, type TerrainGrid } from "@/radar/terrainGrid";
import demoTerrain from "@/mock/demo-terrain.json";

export type RadarTerrainStatus = "idle" | "loading" | "ready" | "unavailable";

export interface RadarTerrainData {
  grid: TerrainGrid | null;
  status: RadarTerrainStatus;
  /** True when this is the bundled demo sample. */
  demo: boolean;
}

export interface UseRadarTerrainOptions {
  client: ApiClient | null;
  observer: { lat: number; lon: number } | null;
  /** The radar's current outer-ring range (km), auto or fixed. */
  rangeKm: number;
  /** Fetch only once the radar has been tilted; stable-idle until then. */
  enabled: boolean;
  demoMode: boolean;
}

const DEMO_GRID = toTerrainGrid(demoTerrain);
const DEMO: RadarTerrainData = { grid: DEMO_GRID, status: DEMO_GRID ? "ready" : "unavailable", demo: true };
const IDLE: RadarTerrainData = { grid: null, status: "idle", demo: false };
const UNAVAILABLE: RadarTerrainData = { grid: null, status: "unavailable", demo: false };
const LOADING: RadarTerrainData = { grid: null, status: "loading", demo: false };

/** Small LRU of recent grids by request (centre + radius). */
const CACHE_SIZE = 4;
const cache = new Map<string, TerrainGrid | null>();
const keyOf = (a: FetchedArea) => `${a.lat},${a.lon},${a.radiusKm}`;
function remember(key: string, grid: TerrainGrid | null) {
  cache.delete(key);
  cache.set(key, grid);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
}

/** Test seam: forget cached grids. */
export function clearRadarTerrainCache() {
  cache.clear();
}

export function useRadarTerrain({
  client,
  observer,
  rangeKm,
  enabled,
  demoMode,
}: UseRadarTerrainOptions): RadarTerrainData {
  const apiAllowed = useApiAllowed();
  const live = enabled && !demoMode && client != null && apiAllowed;
  // The area the grid is (being) fetched for; moves only when the refetch policy says so.
  const [area, setArea] = useState<FetchedArea | null>(null);
  // The area whose fetch failed: shown as unavailable, retried once the wanted area changes.
  const [failedKey, setFailedKey] = useState<string | null>(null);
  // The last grid that arrived, shown while the next one loads.
  const [last, setLast] = useState<TerrainGrid | null>(null);

  const lat = observer?.lat ?? null;
  const lon = observer?.lon ?? null;
  if (live && lat != null && lon != null) {
    const next: FetchedArea = { lat: roundCentre(lat), lon: roundCentre(lon), radiusKm: terrainRadiusFor(rangeKm) };
    const current = area ? keyOf(area) : null;
    const wanted = shouldRefetchTerrain(area, { lat, lon }, rangeKm) || (failedKey != null && failedKey === current);
    // Adjusting state during render (no effect round-trip); converges since `next` then satisfies the policy.
    if (wanted && keyOf(next) !== current) setArea(next);
  }

  useEffect(() => {
    if (!live || !area || !client) return;
    const key = keyOf(area);
    if (cache.has(key)) return;
    let cancelled = false;
    client
      .terrain(area.lat, area.lon, area.radiusKm)
      .then((res) => {
        const grid = toTerrainGrid(res);
        // Cached even when abandoned meanwhile, so coming back to this area/range costs nothing.
        remember(key, grid);
        if (cancelled) return;
        if (grid) setLast(grid);
        else setFailedKey(key);
      })
      .catch(() => {
        if (!cancelled) setFailedKey(key);
      });
    return () => {
      cancelled = true;
    };
  }, [live, area, client]);

  if (!enabled) return IDLE;
  if (demoMode) return DEMO;
  if (!apiAllowed || !client) return UNAVAILABLE;
  const key = area ? keyOf(area) : null;
  if (key != null && cache.has(key)) {
    const grid = cache.get(key) ?? null;
    return grid ? { grid, status: "ready", demo: false } : UNAVAILABLE;
  }
  if (key != null && key === failedKey) return UNAVAILABLE;
  if (last) return { grid: last, status: "ready", demo: false };
  return area ? LOADING : IDLE;
}
