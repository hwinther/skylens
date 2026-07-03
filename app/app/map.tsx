/**
 * Native Map view: two spatial renderings, switchable — Radar (you-centric, offline) and the real
 * react-native-maps MapView. Reads the same 1 Hz store; tapping a marker/blip opens the detail sheet.
 * Web has no react-native-maps — see map.web.tsx (Leaflet). The flat list lives in the List tab.
 */

import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MapView, { Marker } from "react-native-maps";
import { useAircraftList } from "@/state/aircraftStore";
import { useSettingsStore } from "@/state/settingsStore";
import { DetailSheet, AircraftRadar } from "@/components";
import { MapViewToggle, type MapView as MapViewMode } from "@/components/webmap/MapViewToggle";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl, getHomeLocation } from "@/api/config";
import { DEMO_HOME } from "@/mock/mockFeed";

export default function MapScreen() {
  const aircraft = useAircraftList();
  const demoMode = useSettingsStore((s) => s.demoMode);
  const [view, setView] = useState<MapViewMode>("radar");
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const client = useMemo(() => new ApiClient({ baseUrl: getApiBaseUrl() }), []);
  const observer = useMemo(
    () => (demoMode ? DEMO_HOME : (getHomeLocation() ?? DEMO_HOME)),
    [demoMode],
  );
  const positioned = aircraft.filter((a) => a.lat != null && a.lon != null);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <MapViewToggle view={view} onChange={setView} count={positioned.length} />
      <View style={styles.body}>
        {view === "radar" ? (
          <AircraftRadar aircraft={positioned} observer={observer} onSelect={setSelectedHex} />
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
              <Marker
                key={a.hex}
                coordinate={{ latitude: a.lat as number, longitude: a.lon as number }}
                title={a.flight?.trim() || a.hex.toUpperCase()}
                description={a.fl != null ? `FL${a.fl}` : undefined}
                onPress={() => setSelectedHex(a.hex)}
              />
            ))}
          </MapView>
        )}
      </View>
      <DetailSheet hex={selectedHex} client={client} onClose={() => setSelectedHex(null)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B1622" },
  body: { flex: 1 },
});
