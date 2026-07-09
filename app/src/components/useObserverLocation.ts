/**
 * Observer position for live mode. Precedence:
 *  1. Baked EXPO_PUBLIC_HOME_LAT/LON (dev / source-mode e2e — see playwright.config.ts).
 *  2. A one-shot device geolocation fix. expo-location wraps navigator.geolocation on web,
 *     which is what the container/preview builds rely on: public bundles deliberately bake
 *     NO home coordinates, and the container-mode e2e grants the browser geolocation
 *     permission pinned to the compose FEED origin (playwright.ci.config.ts).
 *
 * Returns null until either source yields a position; useLiveFeed simply keeps the hub
 * connection open without subscribing until then (its pre-existing no-position behavior).
 * Denied/unavailable geolocation is swallowed — live mode then shows a connected, empty feed.
 */

import { useEffect, useState } from "react";
import * as Location from "expo-location";
import { getHomeLocation, type HomeLocation } from "@/api/config";

export function useObserverLocation(enabled: boolean): HomeLocation | null {
  // Baked home coords are fixed for the app's lifetime — resolve once.
  const [home] = useState<HomeLocation | null>(() => getHomeLocation());
  const [fix, setFix] = useState<HomeLocation | null>(null);

  useEffect(() => {
    if (!enabled || home || fix) return;
    let alive = true;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (!alive || status !== "granted") return;
        const pos = await Location.getCurrentPositionAsync({});
        if (alive)
          setFix({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            ...(pos.coords.altitude != null ? { alt: pos.coords.altitude } : {}),
          });
      } catch {
        // No geolocation (denied, unsupported, timeout): stay null. The hub subscription
        // just never happens, matching the previous behavior when no position was known.
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled, home, fix]);

  return home ?? fix;
}
