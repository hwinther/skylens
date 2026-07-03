/**
 * Web Map view: two spatial renderings of the same traffic, switchable — Radar (offline, you-centric)
 * and a real OpenStreetMap (Leaflet). react-native-maps has no web build, so Metro resolves this file
 * on web; native keeps map.tsx. The flat list lives in its own List tab now.
 */

import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAircraftList } from "@/state/aircraftStore";
import { useSettingsStore } from "@/state/settingsStore";
import { DetailSheet, AircraftRadar } from "@/components";
import { MapViewToggle, type MapView } from "@/components/webmap/MapViewToggle";
import { LeafletMap } from "@/components/webmap/LeafletMap";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl, getHomeLocation } from "@/api/config";
import { DEMO_HOME } from "@/mock/mockFeed";

export default function MapScreen() {
  const aircraft = useAircraftList();
  const demoMode = useSettingsStore((s) => s.demoMode);
  const [view, setView] = useState<MapView>("radar");
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
      <View testID="map-web" style={styles.body}>
        {view === "radar" ? (
          <AircraftRadar aircraft={positioned} observer={observer} onSelect={setSelectedHex} />
        ) : (
          <LeafletMap aircraft={positioned} observer={observer} onSelect={setSelectedHex} />
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
