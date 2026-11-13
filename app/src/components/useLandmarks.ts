/**
 * Landmarks for AR identify. Live mode fetches GET /api/landmarks once for the observer's area and again
 * only after the observer moves LANDMARK_REFETCH_KM (src/ar/identify.ts) — the matching itself runs
 * locally per move, never one request per frame. Demo mode has no API: it serves a small bundled sample
 * of real GeoNames rows around the demo home (src/mock/demo-landmarks.json), kept apart from live data.
 *
 * Gated like every API caller (useApiAllowed): signed out behind real auth, live mode stays empty. Lazy:
 * nothing is fetched until `enabled` (the user has used identify), so the AR screen costs nothing extra.
 */

import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import type { LandmarkDto } from "@/api/types";
import { LANDMARK_FETCH_RADIUS_KM, shouldRefetchLandmarks } from "@/ar/identify";
import { useApiAllowed } from "@/state/authStore";
import demoLandmarks from "@/mock/demo-landmarks.json";

/** The credit CC BY 4.0 asks for; the live response carries the same string. */
export const LANDMARKS_ATTRIBUTION = "GeoNames (CC BY 4.0)";

export type LandmarksStatus = "idle" | "loading" | "ready" | "unavailable";

export interface LandmarksData {
  landmarks: LandmarkDto[];
  attribution: string | null;
  status: LandmarksStatus;
  /** True when this is the bundled demo sample. */
  demo: boolean;
}

export interface UseLandmarksOptions {
  client: ApiClient;
  observer: { lat: number; lon: number } | null;
  /** Fetch only once identify has been used; stable-empty until then. */
  enabled: boolean;
  demoMode: boolean;
}

const DEMO: LandmarksData = {
  landmarks: demoLandmarks as LandmarkDto[],
  attribution: LANDMARKS_ATTRIBUTION,
  status: "ready",
  demo: true,
};
const IDLE: LandmarksData = { landmarks: [], attribution: null, status: "idle", demo: false };
const UNAVAILABLE: LandmarksData = { landmarks: [], attribution: null, status: "unavailable", demo: false };

export function useLandmarks({ client, observer, enabled, demoMode }: UseLandmarksOptions): LandmarksData {
  const apiAllowed = useApiAllowed();
  const live = enabled && !demoMode;
  const [data, setData] = useState<LandmarksData>(IDLE);
  // Centre of the last fetch (successful or in flight), for the move-based refetch policy.
  const centreRef = useRef<{ lat: number; lon: number } | null>(null);

  const lat = observer?.lat ?? null;
  const lon = observer?.lon ?? null;

  useEffect(() => {
    if (!live || !apiAllowed || lat == null || lon == null) return;
    if (!shouldRefetchLandmarks(centreRef.current, { lat, lon })) return;
    centreRef.current = { lat, lon };
    let cancelled = false;
    let settled = false;
    setData((d) => (d.status === "ready" ? d : { ...IDLE, status: "loading" }));
    client
      .landmarks(Math.round(lat * 1000) / 1000, Math.round(lon * 1000) / 1000, LANDMARK_FETCH_RADIUS_KM)
      .then((res) => {
        settled = true;
        if (cancelled) return;
        setData({
          landmarks: res.landmarks ?? [],
          attribution: res.attribution ?? LANDMARKS_ATTRIBUTION,
          status: "ready",
          demo: false,
        });
      })
      .catch(() => {
        settled = true;
        if (cancelled) return;
        // Let the next move (or re-enable) try again.
        centreRef.current = null;
        setData(UNAVAILABLE);
      });
    return () => {
      cancelled = true;
      // Abandoned mid-flight (unmount / disabled / moved): forget its centre so the next run fetches.
      if (!settled) centreRef.current = null;
    };
  }, [live, apiAllowed, lat, lon, client]);

  if (demoMode) return enabled ? DEMO : IDLE;
  if (!enabled) return IDLE;
  if (!apiAllowed) return UNAVAILABLE;
  return data;
}
