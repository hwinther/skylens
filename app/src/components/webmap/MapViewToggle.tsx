/** Segmented switch between the two spatial Map renderings — Radar (offline, you-centric) and the
 *  real geographic Map — plus the live aircraft count. */

import { color } from "@/theme";
import { Pressable, StyleSheet, Text, View } from "react-native";

export type MapView = "radar" | "map";

export interface MapViewToggleProps {
  view: MapView;
  onChange: (view: MapView) => void;
  count: number;
}

export function MapViewToggle({ view, onChange, count }: MapViewToggleProps) {
  return (
    <View style={styles.bar}>
      <View style={styles.segment}>
        {(["radar", "map"] as const).map((v) => (
          <Pressable
            key={v}
            testID={`map-view-${v}`}
            onPress={() => onChange(v)}
            style={[styles.seg, view === v && styles.segActive]}
          >
            <Text style={[styles.segText, view === v && styles.segTextActive]}>
              {v === "radar" ? "Radar" : "Map"}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text testID="map-aircraft-count" style={styles.count}>
        {count} aircraft
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  segment: { flexDirection: "row", backgroundColor: "#12283d", borderRadius: 8, padding: 2 },
  seg: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6 },
  segActive: { backgroundColor: color.accentFill },
  segText: { color: color.textDim, fontSize: 13, fontWeight: "600" },
  segTextActive: { color: color.text },
  count: { color: color.textDim, fontSize: 12 },
});
