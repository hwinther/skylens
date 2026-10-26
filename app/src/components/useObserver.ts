/**
 * Observer position for screens that measure from "you" (List distances/bearings, Radar and Map
 * centre, satellite/planet look angles). Demo mode uses the demo series' home. Live mode uses the
 * shared live position (baked home or device GPS, see observerStore); until the first fix arrives
 * it falls back to the demo home as a placeholder, which is harmless because the hub does not
 * subscribe (so no traffic is listed) without a position either.
 *
 * Previously List and Map used `getHomeLocation() ?? DEMO_HOME`, and release/web builds bake no
 * home, so away from home every distance was measured from the demo area.
 */

import { useMemo } from "react";
import type { HomeLocation } from "@/api/config";
import { DEMO_HOME } from "@/mock/mockFeed";
import { useObserverStore } from "@/state/observerStore";
import { useSettingsStore } from "@/state/settingsStore";

/** Pure resolution, exported for tests. */
export function resolveObserver(demoMode: boolean, live: HomeLocation | null): HomeLocation {
  if (demoMode) return DEMO_HOME;
  return live ?? DEMO_HOME;
}

export function useObserver(): HomeLocation {
  const demoMode = useSettingsStore((s) => s.demoMode);
  const live = useObserverStore((s) => s.position);
  return useMemo(() => resolveObserver(demoMode, live), [demoMode, live]);
}

/** The live position only (null until the first fix) — for "acquiring GPS" style hints. */
export function useLiveObserver(): HomeLocation | null {
  return useObserverStore((s) => s.position);
}
