/**
 * Fetch hook for the airports map/radar layer. Airports are static reference points, so this fetches
 * ONCE when the layer is switched on (and again only if the observer moves) — there is no polling
 * interval, unlike the live-traffic or satellite loops.
 *
 * It is deliberately fail-soft: any error (auth 401, network drop, a 503) collapses to a STABLE empty
 * array so the map simply draws nothing. It never throws and never blocks the map. Fetching only runs
 * while `enabled` and an observer position is known.
 */

import { useEffect, useState } from "react";
import type { ApiClient } from "@/api/client";
import type { AirportDto } from "@/api/types";
import type { Observer } from "./webmap/relative";

/** Airports are baked reference data; 150 km comfortably covers any radar/map view around the observer. */
export const AIRPORTS_RADIUS_KM = 150;

export interface UseAirportsOptions {
  /** Typed API client (the same instance the screen already builds). */
  client: ApiClient;
  /** Observer position; airports are refetched only when this moves. Null until a fix is known. */
  observer: Observer | null;
  /** Fetch only while the airports layer is on. Stable-empty when false. */
  enabled: boolean;
}

// Stable empty singleton so an idle/failed hook returns the same reference frame to frame.
const NO_AIRPORTS: AirportDto[] = [];

export function useAirports({ client, observer, enabled }: UseAirportsOptions): AirportDto[] {
  const [airports, setAirports] = useState<AirportDto[]>(NO_AIRPORTS);

  // Round the observer to ~1 km so tiny GPS jitter never triggers a needless refetch of static data.
  const lat = observer ? Math.round(observer.lat * 100) / 100 : null;
  const lon = observer ? Math.round(observer.lon * 100) / 100 : null;

  // The state update lives inside the async .then/.catch (never synchronously in the effect body) so this
  // stays clear of react-hooks/set-state-in-effect; when disabled the derived return below masks to empty.
  useEffect(() => {
    if (!enabled || lat == null || lon == null) return;
    let cancelled = false;
    client
      .airports(lat, lon, AIRPORTS_RADIUS_KM)
      .then((res) => {
        if (!cancelled) setAirports(res.airports ?? NO_AIRPORTS);
      })
      .catch(() => {
        if (!cancelled) setAirports(NO_AIRPORTS);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, lat, lon, client]);

  return enabled ? airports : NO_AIRPORTS;
}
