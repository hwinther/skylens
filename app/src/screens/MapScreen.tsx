/**
 * Native Map view: two spatial renderings, switchable — Radar (you-centric, offline) and the real
 * react-native-maps MapView. Reads the same 1 Hz store; tapping a marker/blip opens the detail sheet.
 * Web has no react-native-maps — see MapScreen.web.tsx (Leaflet). The flat list lives in the List tab.
 */

import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MapView, { Marker } from "react-native-maps";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { AircraftDto, VesselDto } from "@/api/types";
import { useAircraftList } from "@/state/aircraftStore";
import { useVesselList } from "@/state/vesselStore";
import { useSettingsStore } from "@/state/settingsStore";
import { DetailSheet, AircraftRadar, VesselDetailSheet } from "@/components";
import { iconForVessel } from "@/components/vesselIcon";
import { MapViewToggle, type MapView as MapViewMode } from "@/components/webmap/MapViewToggle";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl, getHomeLocation } from "@/api/config";
import { DEMO_HOME } from "@/mock/mockFeed";

/**
 * One aircraft as a top-down airplane icon rotated to its track, laid flat on the map so the nose
 * points where it's heading (MaterialCommunityIcons "airplane" points north at rotation 0).
 * react-native-maps re-rasterises a custom marker view on every render, which would thrash at
 * 1 Hz x N aircraft — so we only let it track view changes briefly after mount (long enough to
 * capture the icon bitmap), then freeze it. Position (coordinate) and heading (rotation) still
 * update natively while frozen, so the marker keeps moving/turning without re-rasterising.
 */
function AircraftMarker({
  aircraft: a,
  onSelect,
}: {
  aircraft: AircraftDto;
  onSelect: (hex: string) => void;
}) {
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setTracksViewChanges(false), 800);
    return () => clearTimeout(t);
  }, []);
  return (
    <Marker
      coordinate={{ latitude: a.lat as number, longitude: a.lon as number }}
      title={a.flight?.trim() || a.hex.toUpperCase()}
      description={a.fl != null ? `FL${a.fl}` : undefined}
      onPress={() => onSelect(a.hex)}
      anchor={{ x: 0.5, y: 0.5 }}
      flat
      rotation={a.trk ?? 0}
      tracksViewChanges={tracksViewChanges}
    >
      <MaterialCommunityIcons name="airplane" size={24} color="#FFB450" />
    </Marker>
  );
}

/**
 * One vessel as its class icon. Ships are rotated flat to their course-over-ground (heading as a
 * fallback) so the icon points where they're steaming; AtoNs are stationary and drawn upright. Same
 * tracksViewChanges freeze as AircraftMarker so 1 Hz × N ships don't re-rasterise. Tapping it opens
 * the vessel detail sheet (mirrors AircraftMarker).
 */
function VesselMarker({
  vessel: v,
  onSelect,
}: {
  vessel: VesselDto;
  onSelect: (mmsi: string) => void;
}) {
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setTracksViewChanges(false), 800);
    return () => clearTimeout(t);
  }, []);
  const { name, color } = iconForVessel(v);
  const isShip = v.kind === "ship";
  return (
    <Marker
      coordinate={{ latitude: v.lat as number, longitude: v.lon as number }}
      title={v.name?.trim() || v.mmsi}
      description={v.sog != null ? `${Math.round(v.sog)} kn` : undefined}
      onPress={() => onSelect(v.mmsi)}
      anchor={{ x: 0.5, y: 0.5 }}
      flat
      rotation={isShip ? (v.cog ?? v.hdg ?? 0) : 0}
      tracksViewChanges={tracksViewChanges}
    >
      <MaterialCommunityIcons name={name} size={22} color={color} />
    </Marker>
  );
}

export default function MapScreen() {
  const aircraft = useAircraftList();
  const vessels = useVesselList();
  const demoMode = useSettingsStore((s) => s.demoMode);
  const showShips = useSettingsStore((s) => s.showShips);
  const showAton = useSettingsStore((s) => s.showAton);
  const radarRangeKm = useSettingsStore((s) => s.radarRangeKm);
  const setRadarRangeKm = useSettingsStore((s) => s.setRadarRangeKm);
  const [view, setView] = useState<MapViewMode>("radar");
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [selectedMmsi, setSelectedMmsi] = useState<string | null>(null);
  const client = useMemo(() => new ApiClient({ baseUrl: getApiBaseUrl() }), []);
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
      <View style={styles.body}>
        {view === "radar" ? (
          <AircraftRadar
            aircraft={positioned}
            vessels={positionedVessels}
            observer={observer}
            onSelect={setSelectedHex}
            onSelectVessel={setSelectedMmsi}
            rangeKm={radarRangeKm}
            onRangeChange={setRadarRangeKm}
          />
        ) : (
          <MapView
            style={StyleSheet.absoluteFill}
            initialRegion={{ latitude: observer.lat, longitude: observer.lon, latitudeDelta: 1.2, longitudeDelta: 1.2 }}
            showsUserLocation
          >
            <Marker
              coordinate={{ latitude: observer.lat, longitude: observer.lon }}
              title="You"
              pinColor="#78C8FF"
            />
            {positioned.map((a) => (
              <AircraftMarker key={a.hex} aircraft={a} onSelect={setSelectedHex} />
            ))}
            {positionedVessels.map((v) => (
              <VesselMarker key={v.mmsi} vessel={v} onSelect={setSelectedMmsi} />
            ))}
          </MapView>
        )}
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
});
