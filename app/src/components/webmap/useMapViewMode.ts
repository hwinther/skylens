/**
 * The Map tab's Radar/Map switch, shared by both Map screens: opens on the Map when it can draw
 * (initialMapView), and snaps to the Map when a satellite track is selected or a new "Show on map"
 * request arrives, since neither shows on the Radar. expo-router keeps the tab mounted across a
 * re-navigation from a detail sheet, so the mount-time default alone can't catch a selection made
 * while the tab already sits on the Radar.
 *
 * The snaps only happen when the Map can draw; on an Android build without a Maps key the user stays
 * on the Radar (and can still switch by hand).
 */

import { useEffect, useState } from "react";
import { useMapFocusStore } from "@/state/mapFocusStore";
import { isMapAvailable } from "./mapAvailable";
import { initialMapView, type MapView } from "./mapView";

export function useMapViewMode(trackedNoradId: number | null) {
  const mapAvailable = isMapAvailable();
  const focus = useMapFocusStore((s) => s.focus);
  const focusSeq = useMapFocusStore((s) => s.seq);
  // Captured once at mount; the effects below handle later requests.
  const [view, setView] = useState<MapView>(() =>
    initialMapView({ hasTrack: trackedNoradId != null, hasFocus: focus != null, mapAvailable }),
  );

  // Snap whenever a track is (re)selected. The guard runs via a named function to stay clear of the
  // set-state-in-effect rule (same discipline as useSatellites' tick()).
  useEffect(() => {
    const snapToMap = () => setView("map");
    if (mapAvailable && trackedNoradId != null) snapToMap();
  }, [mapAvailable, trackedNoradId]);

  // Same snap for each new "Show on map" request (seq bumps even for the same target).
  useEffect(() => {
    const snapToMap = () => setView("map");
    if (mapAvailable && focus != null) snapToMap();
  }, [mapAvailable, focus, focusSeq]);

  return { view, setView };
}
