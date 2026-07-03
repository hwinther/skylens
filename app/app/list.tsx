/**
 * List view: a tabular readout of the current traffic — type icon, callsign, distance + bearing from
 * you, flight level and ground speed — sorted nearest-first. Same 1 Hz store as AR/Map; tap opens the
 * detail sheet. Cross-platform (no map deps).
 */

import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useAircraftList } from "@/state/aircraftStore";
import { useSettingsStore } from "@/state/settingsStore";
import { DetailSheet } from "@/components";
import { iconForCategory } from "@/components/aircraftIcon";
import { compass8, relativePosition } from "@/components/webmap/relative";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl, getHomeLocation } from "@/api/config";
import { DEMO_HOME } from "@/mock/mockFeed";

export default function ListScreen() {
  const aircraft = useAircraftList();
  const demoMode = useSettingsStore((s) => s.demoMode);
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const client = useMemo(() => new ApiClient({ baseUrl: getApiBaseUrl() }), []);
  const observer = useMemo(
    () => (demoMode ? DEMO_HOME : (getHomeLocation() ?? DEMO_HOME)),
    [demoMode],
  );

  const rows = useMemo(
    () =>
      aircraft
        .filter((a) => a.lat != null && a.lon != null)
        .map((a) => ({ a, ...relativePosition(observer, a.lat as number, a.lon as number) }))
        .sort((x, y) => x.distanceKm - y.distanceKm),
    [aircraft, observer],
  );

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <Text testID="list-count" style={styles.heading}>
        Aircraft ({rows.length})
      </Text>
      <ScrollView testID="list-scroll">
        {rows.map(({ a, distanceKm, bearingDeg }) => (
          <Pressable
            key={a.hex}
            testID={`list-ac-${a.hex}`}
            onPress={() => setSelectedHex(a.hex)}
            style={styles.row}
          >
            <MaterialCommunityIcons name={iconForCategory(a.cat)} size={18} color="#78C8FF" />
            <Text style={styles.callsign} numberOfLines={1}>
              {a.flight?.trim() || a.hex.toUpperCase()}
            </Text>
            <Text style={styles.meta}>
              {distanceKm.toFixed(1)} km {compass8(bearingDeg)}
            </Text>
            <Text style={styles.meta}>{a.fl != null ? `FL${String(a.fl).padStart(3, "0")}` : "—"}</Text>
            <Text style={styles.meta}>{a.gs != null ? `${Math.round(a.gs)} kt` : "—"}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <DetailSheet hex={selectedHex} client={client} onClose={() => setSelectedHex(null)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B1622" },
  heading: { color: "#EAF6FF", fontSize: 18, fontWeight: "700", paddingHorizontal: 16, paddingVertical: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderBottomColor: "#16283a",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  callsign: { color: "#EAF6FF", fontSize: 14, fontWeight: "600", flex: 1 },
  meta: { color: "#9FC7E0", fontSize: 12, minWidth: 74, textAlign: "right" },
});
