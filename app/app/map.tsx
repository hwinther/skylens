/**
 * Map / list fallback view: react-native-maps with a marker per positioned aircraft
 * plus the observer's own position. Reads the same 1 Hz aircraft store as the AR
 * view. Tapping a marker opens the detail sheet.
 */

import { useMemo, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import MapView, { Marker } from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAircraftList } from "@/state/aircraftStore";
import { DetailSheet } from "@/components";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl } from "@/api/config";
import { DEMO_HOME } from "@/mock/mockFeed";

export default function MapScreen() {
  const aircraft = useAircraftList();
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const client = useMemo(() => new ApiClient({ baseUrl: getApiBaseUrl() }), []);
  const positioned = aircraft.filter((a) => a.lat != null && a.lon != null);

  const region = {
    latitude: DEMO_HOME.lat,
    longitude: DEMO_HOME.lon,
    latitudeDelta: 1.2,
    longitudeDelta: 1.2,
  };

  // react-native-maps has no web implementation; show a list fallback there.
  if (Platform.OS === "web") {
    return (
      <SafeAreaView style={styles.root}>
        <Text style={styles.heading}>Aircraft ({positioned.length})</Text>
        {positioned.map((a) => (
          <Text key={a.hex} style={styles.listItem}>
            {a.flight?.trim() || a.hex.toUpperCase()} — {a.lat!.toFixed(3)}, {a.lon!.toFixed(3)}
          </Text>
        ))}
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.root}>
      <MapView style={StyleSheet.absoluteFill} initialRegion={region} showsUserLocation>
        <Marker
          coordinate={{ latitude: DEMO_HOME.lat, longitude: DEMO_HOME.lon }}
          title="You"
          pinColor="#78C8FF"
        />
        {positioned.map((a) => (
          <Marker
            key={a.hex}
            coordinate={{ latitude: a.lat!, longitude: a.lon! }}
            title={a.flight?.trim() || a.hex.toUpperCase()}
            description={a.fl != null ? `FL${a.fl}` : undefined}
            onPress={() => setSelectedHex(a.hex)}
          />
        ))}
      </MapView>
      <DetailSheet hex={selectedHex} client={client} onClose={() => setSelectedHex(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B1622" },
  heading: { color: "#EAF6FF", fontSize: 18, fontWeight: "700", padding: 16 },
  listItem: { color: "#9FC7E0", fontSize: 14, paddingHorizontal: 16, paddingVertical: 4 },
});
