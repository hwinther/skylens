/**
 * Web Map view: two spatial renderings of the same traffic, switchable — Radar (offline, you-centric)
 * and a real OpenStreetMap (Leaflet). react-native-maps has no web build, so Metro resolves this
 * MapScreen.web.tsx on web; native gets MapScreen.tsx (imported via the thin app/map.tsx route). The flat list lives in its own List tab now.
 */

import { alpha, color } from "@/theme";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAircraftList } from "@/state/aircraftStore";
import { useVesselList } from "@/state/vesselStore";
import { useSettingsStore } from "@/state/settingsStore";
import { useMapFocusStore } from "@/state/mapFocusStore";
import {
  DetailSheet,
  AircraftRadar,
  AirportDetailSheet,
  VesselDetailSheet,
  useAirports,
  useFishingLayers,
  useSatelliteGroundTrack,
} from "@/components";
import { MapViewToggle, type MapView } from "@/components/webmap/MapViewToggle";
import { LeafletMap } from "@/components/webmap/LeafletMap";
import { airportFilter } from "@/components/webmap/airportStyle";
import { resolveFocus } from "@/components/webmap/focus";
import { MapFocusChip } from "@/components/webmap/MapFocusChip";
import type { LatLngTuple } from "@/components/webmap/geojson";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl } from "@/api/config";
import { useObserver } from "@/components/useObserver";

export default function MapScreen() {
  const aircraft = useAircraftList();
  const vessels = useVesselList();
  const showShips = useSettingsStore((s) => s.showShips);
  const showAton = useSettingsStore((s) => s.showAton);
  const showCourseVectors = useSettingsStore((s) => s.showCourseVectors);
  const showAirports = useSettingsStore((s) => s.showAirports);
  const showSmallAirfields = useSettingsStore((s) => s.showSmallAirfields);
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
  const [selectedAirportIdent, setSelectedAirportIdent] = useState<string | null>(null);
  // Snap to the map view whenever a track is (re)selected — a track only renders there, and expo-router
  // keeps this tab mounted across a re-navigation from the sheet, so the mount-time default alone can't
  // catch a selection made while the tab already sits on radar. Guard runs via a named function to stay
  // clear of the set-state-in-effect rule (same discipline as useSatellites' tick()).
  useEffect(() => {
    const snapToMap = () => setView("map");
    if (track.trackedNoradId != null) snapToMap();
  }, [track.trackedNoradId]);
  // "Show on map" from a detail sheet: same snap, then LeafletMap centres on and follows the target.
  const focus = useMapFocusStore((s) => s.focus);
  const focusSeq = useMapFocusStore((s) => s.seq);
  const following = useMapFocusStore((s) => s.following);
  const setFocus = useMapFocusStore((s) => s.setFocus);
  const setFollowing = useMapFocusStore((s) => s.setFollowing);
  const clearFocus = useMapFocusStore((s) => s.clear);
  useEffect(() => {
    const snapToMap = () => setView("map");
    if (focus != null) snapToMap();
  }, [focus, focusSeq]);
  const stopFollowing = useCallback(() => setFollowing(false), [setFollowing]);
  const target = useMemo(() => resolveFocus(focus, aircraft, vessels), [focus, aircraft, vessels]);
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
  // Device GPS (or baked home) shared via observerStore, not the build-time home alone.
  const observer = useObserver();
  const positioned = aircraft.filter((a) => a.lat != null && a.lon != null);
  // Vessels the toggles allow, positioned only — ships gated by showShips, AtoNs by showAton.
  const positionedVessels = vessels.filter(
    (v) => v.lat != null && v.lon != null && (v.kind === "aton" ? showAton : showShips),
  );
  // Airports: fetched once (static) when the layer is on, then filtered by the small-airfields toggle.
  const airports = useAirports({ client, observer, enabled: showAirports });
  const shownAirports = useMemo(
    () => airports.filter((a) => airportFilter(a.type, showSmallAirfields)),
    [airports, showSmallAirfields],
  );

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <MapViewToggle view={view} onChange={setView} count={positioned.length} />
      <View testID="map-web" style={styles.body}>
        {view === "radar" ? (
          <AircraftRadar
            aircraft={positioned}
            vessels={positionedVessels}
            airports={shownAirports}
            observer={observer}
            onSelect={setSelectedHex}
            onSelectVessel={setSelectedMmsi}
            onSelectAirport={setSelectedAirportIdent}
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
            airports={shownAirports}
            onSelectAirport={setSelectedAirportIdent}
            trackSegments={trackSegments}
            trackSubPoint={trackSubPoint}
            trackName={track.name}
            trackKey={track.trackedNoradId}
            onClearTrack={track.clear}
            showCourseVectors={showCourseVectors}
            focus={target}
            focusSeq={focusSeq}
            following={following}
            onUserPan={stopFollowing}
          />
        )}
        {view === "map" && track.trackedNoradId != null ? (
          <Pressable testID="clear-track" style={styles.clearTrack} onPress={track.clear}>
            <Text style={styles.clearTrackText}>✕ Clear track</Text>
          </Pressable>
        ) : null}
        {view === "map" && target && focus ? (
          <MapFocusChip
            target={target}
            following={following}
            onFollow={() => setFocus(focus)}
            onClear={clearFocus}
          />
        ) : null}
      </View>
      <DetailSheet hex={selectedHex} client={client} onClose={() => setSelectedHex(null)} />
      <VesselDetailSheet
        mmsi={selectedMmsi}
        vessel={selectedMmsi != null ? vessels.find((v) => v.mmsi === selectedMmsi) : undefined}
        onClose={() => setSelectedMmsi(null)}
      />
      <AirportDetailSheet
        ident={selectedAirportIdent}
        airport={
          selectedAirportIdent != null
            ? airports.find((a) => a.ident === selectedAirportIdent)
            : undefined
        }
        onClose={() => setSelectedAirportIdent(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  body: { flex: 1 },
  clearTrack: {
    position: "absolute",
    top: 12,
    right: 12,
    // Above Leaflet's panes (z-index 400-700); without it the canvas swallows the tap.
    zIndex: 1000,
    backgroundColor: alpha(color.bg, 0.9),
    borderColor: color.entity.orbit,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  clearTrackText: { color: color.entity.orbit, fontSize: 13, fontWeight: "700" },
});
