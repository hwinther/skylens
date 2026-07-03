/**
 * Web variant of the map screen. react-native-maps has no web implementation, so on web
 * Metro resolves this file instead of map.tsx and we render a plain aircraft list from the
 * same 1 Hz store — no MapView import reaches the web bundle. Native keeps map.tsx.
 */

import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAircraftList } from "@/state/aircraftStore";
import { DetailSheet } from "@/components";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl } from "@/api/config";

export default function MapScreen() {
  const aircraft = useAircraftList();
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const client = useMemo(() => new ApiClient({ baseUrl: getApiBaseUrl() }), []);
  const positioned = aircraft.filter((a) => a.lat != null && a.lon != null);

  return (
    <SafeAreaView style={styles.root}>
      <Text testID="map-aircraft-count" style={styles.heading}>
        Aircraft ({positioned.length})
      </Text>
      <ScrollView testID="map-web" style={styles.list}>
        {positioned.map((a) => (
          <Text
            key={a.hex}
            testID={`map-ac-${a.hex}`}
            style={styles.listItem}
            onPress={() => setSelectedHex(a.hex)}
          >
            {a.flight?.trim() || a.hex.toUpperCase()} — {a.lat!.toFixed(3)}, {a.lon!.toFixed(3)}
          </Text>
        ))}
      </ScrollView>
      <DetailSheet hex={selectedHex} client={client} onClose={() => setSelectedHex(null)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B1622" },
  heading: { color: "#EAF6FF", fontSize: 18, fontWeight: "700", padding: 16 },
  list: { flex: 1 },
  listItem: { color: "#9FC7E0", fontSize: 14, paddingHorizontal: 16, paddingVertical: 6 },
});
