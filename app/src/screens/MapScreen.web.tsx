/**
 * Web Map view: two spatial renderings of the same traffic, switchable — Radar (offline, you-centric)
 * and a real OpenStreetMap (Leaflet). react-native-maps has no web build, so Metro resolves this
 * MapScreen.web.tsx on web; native gets MapScreen.tsx (imported via the thin app/map.tsx route). The flat list lives in its own List tab now.
 */

import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAircraftList } from "@/state/aircraftStore";
import { useVesselList } from "@/state/vesselStore";
import { useSettingsStore } from "@/state/settingsStore";
import {
  DetailSheet,
  AircraftRadar,
  VesselDetailSheet,
  useFishingLayers,
  useSatelliteGroundTrack,
} from "@/components";
import { MapViewToggle, type MapView } from "@/components/webmap/MapViewToggle";
import { LeafletMap } from "@/components/webmap/LeafletMap";
import type { LatLngTuple } from "@/components/webmap/geojson";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl, getHomeLocation } from "@/api/config";
import { DEMO_HOME } from "@/mock/mockFeed";

// Violet family — matches the satellite marker / detail sheet; distinct from the other overlays.
const SAT_VIOLET = "#C792EA";

export default function MapScreen() {
  const aircraft = useAircraftList();
  const vessels = useVesselList();
  const demoMode = useSettingsStore((s) => s.demoMode);
  const showShips = useSettingsStore((s) => s.showShips);
  const showAton = useSettingsStore((s) => s.showAton);
  const showCourseVectors = useSettingsStore((s) => s.showCourseVectors);
  const showFishingZones = useSettingsStore((s) => s.showFishingZones);
  const showLostGear = useSettingsStore((s) => s.showLostGear);
  const radarRangeKm = useSettingsStore((s) => s.radarRangeKm);
  const setRadarRangeKm = useSettingsStore((s) => s.setRadarRangeKm);
  const client = useMemo(() => new ApiClient({ baseUrl: getApiBaseUrl() }), []);
  // Ground track for the satellite (if any) selected from a detail sheet. Reads the ephemeral store.
  const track = useSatelliteGroundTrack(client);
  // Arriving from "Show ground track" (a track is set) opens the real Map, not the you-centric radar —
  // a globe-spanning track is meaningless on the radar. Captured once at mount.
  const [view, setView] = useState<MapView>(track.trackedNoradId != null ? "map" : "radar");
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [selectedMmsi, setSelectedMmsi] = useState<string | null>(null);
  // Snap to the map view whenever a track is (re)selected — a track only renders there, and expo-router
  // keeps this tab mounted across a re-navigation from the sheet, so the mount-time default alone can't
  // catch a selection made while the tab already sits on radar. Guard runs via a named function to stay
  // clear of the set-state-in-effect rule (same discipline as useSatellites' tick()).
  useEffect(() => {
    const snapToMap = () => setView("map");
    if (track.trackedNoradId != null) snapToMap();
  }, [track.trackedNoradId]);
  // Fishing overlays fetch only when at least one toggle is on; fail-soft to empty when unconfigured.
  const { zones, gear } = useFishingLayers({
    client,
    enabled: showFishingZones || showLostGear,
  });
  // Convert the ground-track segments to Leaflet [lat,lng] tuples once per recompute (not per render).
  const trackSegments = useMemo<LatLngTuple[][]>(
    () => (view === "map" ? track.segments.map((seg) => seg.map((p) => [p.lat, p.lon] as LatLngTuple)) : []),
    [view, track.segments],
  );
  const trackSubPoint = useMemo<LatLngTuple | null>(
    () => (view === "map" && track.subPoint ? [track.subPoint.lat, track.subPoint.lon] : null),
    [view, track.subPoint],
  );
  const observer = useMemo(
    () => (demoMode ? DEMO_HOME : (getHomeLocation() ?? DEMO_HOME)),
    [demoMode],
  );
  const positioned = aircraft.filter((a) => a.lat != null && a.lon != null);
  // Vessels the toggles allow, positioned only — ships gated by showShips, AtoNs by showAton.
  const positionedVessels = vessels.filter(
    (v) => v.lat != null && v.lon != null && (v.kind === "aton" ? showAton : showShips),
  );

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <MapViewToggle view={view} onChange={setView} count={positioned.length} />
      <View testID="map-web" style={styles.body}>
        {view === "radar" ? (
          <AircraftRadar
            aircraft={positioned}
            vessels={positionedVessels}
            observer={observer}
            onSelect={setSelectedHex}
            onSelectVessel={setSelectedMmsi}
            rangeKm={radarRangeKm}
            onRangeChange={setRadarRangeKm}
            showCourseVectors={showCourseVectors}
          />
        ) : (
          <LeafletMap
            aircraft={positioned}
            vessels={positionedVessels}
            observer={observer}
            onSelect={setSelectedHex}
            onSelectVessel={setSelectedMmsi}
            zones={showFishingZones ? zones : []}
            gear={showLostGear ? gear : []}
            trackSegments={trackSegments}
            trackSubPoint={trackSubPoint}
            trackName={track.name}
            trackKey={track.trackedNoradId}
            onClearTrack={track.clear}
            showCourseVectors={showCourseVectors}
          />
        )}
        {view === "map" && track.trackedNoradId != null ? (
          <Pressable testID="clear-track" style={styles.clearTrack} onPress={track.clear}>
            <Text style={styles.clearTrackText}>✕ Clear track</Text>
          </Pressable>
        ) : null}
      </View>
      <DetailSheet hex={selectedHex} client={client} onClose={() => setSelectedHex(null)} />
      <VesselDetailSheet
        mmsi={selectedMmsi}
        vessel={selectedMmsi != null ? vessels.find((v) => v.mmsi === selectedMmsi) : undefined}
        onClose={() => setSelectedMmsi(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B1622" },
  body: { flex: 1 },
  clearTrack: {
    position: "absolute",
    top: 12,
    right: 12,
    backgroundColor: "rgba(11, 22, 34, 0.9)",
    borderColor: SAT_VIOLET,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  clearTrackText: { color: SAT_VIOLET, fontSize: 13, fontWeight: "700" },
});
