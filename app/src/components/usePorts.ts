/**
 * Fetch hook for the ports map layer — the ports counterpart to useAirports. Ports are static reference
 * data, so this fetches once when the layer is switched on and again only when the observer moves
 * (rounded to ~1 km). Fail-soft: any error collapses to a stable empty result, so the map draws nothing.
 */

import { useEffect, useState } from "react";
import type { ApiClient } from "@/api/client";
import type { PortDto } from "@/api/types";
import type { Observer } from "./webmap/relative";

/** Same reach as the airports layer: covers any map view around the observer. */
export const PORTS_RADIUS_KM = 150;

export interface UsePortsOptions {
  client: ApiClient;
  /** Observer position; ports are refetched only when this moves. Null until a fix is known. */
  observer: Observer | null;
  /** Fetch only while the ports layer is on. Stable-empty when false. */
  enabled: boolean;
}

export interface PortsData {
  ports: PortDto[];
  /** Credit to show with the ports (ODbL requires the OpenStreetMap one); null until loaded. */
  attribution: string | null;
}

const NONE: PortsData = { ports: [], attribution: null };

export function usePorts({ client, observer, enabled }: UsePortsOptions): PortsData {
  const [data, setData] = useState<PortsData>(NONE);

  const lat = observer ? Math.round(observer.lat * 100) / 100 : null;
  const lon = observer ? Math.round(observer.lon * 100) / 100 : null;

  useEffect(() => {
    if (!enabled || lat == null || lon == null) return;
    let cancelled = false;
    client
      .ports(lat, lon, PORTS_RADIUS_KM)
      .then((res) => {
        if (!cancelled) setData({ ports: res.ports ?? [], attribution: res.attribution ?? null });
      })
      .catch(() => {
        if (!cancelled) setData(NONE);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, lat, lon, client]);

  return enabled ? data : NONE;
}
