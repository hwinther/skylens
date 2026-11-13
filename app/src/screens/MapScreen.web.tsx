/**
 * Web Map view: two spatial renderings of the same traffic, switchable — a real OpenStreetMap
 * (Leaflet, the default) and Radar (offline, you-centric). react-native-maps has no web build, so
 * Metro resolves this MapScreen.web.tsx on web; native gets MapScreen.tsx (imported via the thin app/map.tsx route). The flat list lives in its own List tab now.
 */

import { alpha, color } from "@/theme";
import { useCallback, useMemo } from "react";
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
  SatelliteDetailSheet,
  VesselDetailSheet,
  useAirports,
  useOverheadSatellites,
  usePorts,
  useFishingLayers,
  useSatelliteGroundTrack,
} from "@/components";
import {
  footprintSatellite,
  mapSatellites,
  satelliteFootprint,
  showTrackedMarker,
} from "@/components/webmap/satelliteLayer";
import { MapViewToggle } from "@/components/webmap/MapViewToggle";
import { useMapViewMode } from "@/components/webmap/useMapViewMode";
import { LeafletMap } from "@/components/webmap/LeafletMap";
import { airportFilter } from "@/components/webmap/airportStyle";
import { resolveFocus } from "@/components/webmap/focus";
import { MapFocusChip } from "@/components/webmap/MapFocusChip";
import type { LatLngTuple } from "@/components/webmap/geojson";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl } from "@/api/config";
import { useObserver } from "@/components/useObserver";
import { useDetailSelection } from "@/components/useDetailSelection";
import { useSheetRightInset } from "@/components/Sheet";

export default function MapScreen() {
  const aircraft = useAircraftList();
  const vessels = useVesselList();
  const showShips = useSettingsStore((s) => s.showShips);
  const showAton = useSettingsStore((s) => s.showAton);
  const showCourseVectors = useSettingsStore((s) => s.showCourseVectors);
  const showAirports = useSettingsStore((s) => s.showAirports);
  const showSmallAirfields = useSettingsStore((s) => s.showSmallAirfields);
  const showPorts = useSettingsStore((s) => s.showPorts);
  const showFishingZones = useSettingsStore((s) => s.showFishingZones);
  const showLostGear = useSettingsStore((s) => s.showLostGear);
  const radarRangeKm = useSettingsStore((s) => s.radarRangeKm);
  const setRadarRangeKm = useSettingsStore((s) => s.setRadarRangeKm);
  const client = useMemo(() => new ApiClient({ baseUrl: getApiBaseUrl() }), []);
  // Ground track for the satellite (if any) selected from a detail sheet. Reads the ephemeral store.
  const track = useSatelliteGroundTrack(client);
  // Map by default; snaps to the Map for a track or a "Show on map" request (see useMapViewMode).
  const { view, setView } = useMapViewMode(track.trackedNoradId);
  // One selection slot for the detail cards: they are non-modal, so tapping another marker (of any
  // kind) swaps the open card instead of stacking a second one.
  const detail = useDetailSelection();
  const selectedHex = detail.idOf("aircraft");
  const selectedMmsi = detail.idOf("vessel");
  const selectedAirportIdent = detail.idOf("airport");
  const selectedSat = detail.idOf("satellite");
  const selectedNoradId = selectedSat != null ? Number(selectedSat) : null;
  const {
    aircraft: setSelectedHex,
    vessel: setSelectedMmsi,
    airport: setSelectedAirportIdent,
    satellite: setSelectedSat,
  } = detail.set;
  const selectSatellite = useCallback((id: number) => setSelectedSat(String(id)), [setSelectedSat]);
  // While a side-panel card is open, right-edge controls move left by its width.
  const cardRightInset = useSheetRightInset(detail.open);
  // "Show on map" from a detail sheet: useMapViewMode snaps to the Map, then LeafletMap centres on and
  // follows the target.
  const focus = useMapFocusStore((s) => s.focus);
  const focusSeq = useMapFocusStore((s) => s.seq);
  const following = useMapFocusStore((s) => s.following);
  const setFocus = useMapFocusStore((s) => s.setFocus);
  const setFollowing = useMapFocusStore((s) => s.setFollowing);
  const clearFocus = useMapFocusStore((s) => s.clear);
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
  // Ports: static reference data like the airports, map view only (the radar stays traffic-focused).
  const { ports } = usePorts({ client, observer, enabled: showPorts });
  // Satellites layer: exactly the List's Overhead set (same hook), each at its sub-satellite point,
  // re-placed at the hook's 1 Hz tick. One footprint, for the open card's satellite (else the tracked one).
  const showMapSatellites = useSettingsStore((s) => s.showMapSatellites);
  const sats = useOverheadSatellites({ client, observer, enabled: showMapSatellites });
  const satMarkers = useMemo(
    () => (view === "map" ? mapSatellites(sats.overhead, showMapSatellites) : []),
    [view, sats.overhead, showMapSatellites],
  );
  const satFootprint = useMemo(
    () =>
      view === "map" && showMapSatellites
        ? satelliteFootprint(footprintSatellite(selectedNoradId, track.trackedNoradId, sats.byNoradId))
        : null,
    [view, showMapSatellites, selectedNoradId, track.trackedNoradId, sats.byNoradId],
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
            controlsRightInset={cardRightInset}
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
            ports={ports}
            trackSegments={trackSegments}
            trackSubPoint={showTrackedMarker(track.trackedNoradId, satMarkers) ? trackSubPoint : null}
            trackName={track.name}
            trackKey={track.trackedNoradId}
            onClearTrack={track.clear}
            satellites={satMarkers}
            onSelectSatellite={selectSatellite}
            satelliteFootprint={satFootprint}
            showCourseVectors={showCourseVectors}
            focus={target}
            focusSeq={focusSeq}
            following={following}
            onUserPan={stopFollowing}
            controlsRightInset={cardRightInset}
          />
        )}
        {view === "map" && track.trackedNoradId != null ? (
          <Pressable
            testID="clear-track"
            style={[styles.clearTrack, { right: 12 + cardRightInset }]}
            onPress={track.clear}
          >
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
        {/* Detail card last, over the map; mounted in the body so the side panel starts below the
            view toggle. */}
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
        <SatelliteDetailSheet
          noradId={selectedNoradId}
          view={selectedNoradId != null ? sats.byNoradId.get(selectedNoradId) : undefined}
          observer={observer}
          elevationMaskDeg={sats.elevationMaskDeg}
          onClose={() => setSelectedSat(null)}
        />
      </View>
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
