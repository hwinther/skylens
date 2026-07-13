/**
 * Fetch hook for the fishing-mode map overlays (regulation zones + lost gear). Both feeds are near-static
 * (FiskInfo publishes them slowly), so this fetches once when the overlay is switched on and refetches on
 * a long 6 h timer — far lighter than the satellite propagation loop.
 *
 * It is deliberately fail-soft: any error (including an unconfigured backend, which answers 200 with empty
 * arrays + a "note") collapses to empty arrays so the map simply draws nothing. It never throws and never
 * blocks the map. Fetching only runs while `enabled` (either overlay toggle on) to avoid needless calls.
 */

import { useEffect, useState } from "react";
import type { ApiClient } from "@/api/client";
import type { FishingZone, LostGear } from "@/api/types";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export type FishingLayersStatus = "idle" | "loading" | "ok" | "unavailable";

export interface UseFishingLayersOptions {
  /** Typed API client (the same instance the screen already builds). */
  client: ApiClient;
  /** Fetch only while an overlay is on (showFishingZones || showLostGear). Idle + empty when false. */
  enabled: boolean;
}

export interface FishingLayers {
  zones: FishingZone[];
  gear: LostGear[];
  status: FishingLayersStatus;
}

const NO_ZONES: FishingZone[] = [];
const NO_GEAR: LostGear[] = [];

export function useFishingLayers({ client, enabled }: UseFishingLayersOptions): FishingLayers {
  const [zones, setZones] = useState<FishingZone[]>(NO_ZONES);
  const [gear, setGear] = useState<LostGear[]>(NO_GEAR);
  // Set only inside the async callback below (never synchronously in the effect body) so this stays clear
  // of react-hooks/set-state-in-effect; the derived `status` below masks it to "idle" while disabled.
  const [fetchStatus, setFetchStatus] = useState<Exclude<FishingLayersStatus, "idle">>("loading");

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let refetchTimer: ReturnType<typeof setTimeout> | undefined;

    const load = () => {
      // Fetch both feeds together; settle independently so one being empty/failing never hides the other.
      Promise.allSettled([client.fishingZones(), client.lostGear()]).then(([zonesRes, gearRes]) => {
        if (cancelled) return;
        setZones(zonesRes.status === "fulfilled" ? (zonesRes.value.zones ?? NO_ZONES) : NO_ZONES);
        setGear(gearRes.status === "fulfilled" ? (gearRes.value.gear ?? NO_GEAR) : NO_GEAR);
        // "unavailable" only when both feeds errored outright; an unconfigured backend still 200s empty.
        setFetchStatus(
          zonesRes.status === "rejected" && gearRes.status === "rejected" ? "unavailable" : "ok",
        );
        refetchTimer = setTimeout(load, SIX_HOURS_MS);
      });
    };

    load();
    return () => {
      cancelled = true;
      if (refetchTimer) clearTimeout(refetchTimer);
    };
  }, [enabled, client]);

  return { zones, gear, status: enabled ? fetchStatus : "idle" };
}
