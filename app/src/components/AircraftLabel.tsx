/**
 * A single absolutely-positioned aircraft label rendered over the camera preview.
 * Position comes from the projection pipeline (already converted to pixels by the
 * overlay). Tapping it opens the detail sheet.
 */

import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { AircraftDto } from "@/api/types";
import { iconForCategory } from "./aircraftIcon";

export interface AircraftLabelProps {
  aircraft: AircraftDto;
  /** Pixel x of the projected point (label anchor). */
  x: number;
  /** Pixel y after declutter. */
  y: number;
  /** Original anchor y, for the leader line back to the true point. */
  anchorY: number;
  /** Slant range in km, for the second line. */
  rangeKm: number | null;
  onPress: (hex: string) => void;
}

function AircraftLabelBase({ aircraft, x, y, anchorY, rangeKm, onPress }: AircraftLabelProps) {
  const title = aircraft.flight?.trim() || aircraft.hex.toUpperCase();
  const fl = aircraft.fl != null ? `FL${String(aircraft.fl).padStart(3, "0")}` : "—";
  const range = rangeKm != null ? `${rangeKm.toFixed(1)} km` : "";
  const pushed = Math.abs(y - anchorY) > 1;

  return (
    <>
      {pushed && (
        <View
          pointerEvents="none"
          style={[
            styles.leader,
            { left: x, top: Math.min(anchorY, y), height: Math.abs(y - anchorY) },
          ]}
        />
      )}
      <Pressable
        testID={`ac-label-${aircraft.hex}`}
        onPress={() => onPress(aircraft.hex)}
        style={[styles.label, { left: x, top: y }]}
        hitSlop={8}
      >
        <View style={styles.tick} />
        <View style={styles.titleRow}>
          <MaterialCommunityIcons
            testID={`ac-icon-${aircraft.hex}`}
            name={iconForCategory(aircraft.cat)}
            size={13}
            color="rgba(120, 200, 255, 0.95)"
            style={styles.icon}
          />
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <Text style={styles.sub} numberOfLines={1}>
          {fl}
          {range ? `  ${range}` : ""}
        </Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  label: {
    position: "absolute",
    transform: [{ translateX: -6 }, { translateY: -6 }],
    backgroundColor: "rgba(11, 22, 34, 0.72)",
    borderColor: "rgba(120, 200, 255, 0.8)",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    maxWidth: 160,
  },
  tick: {
    position: "absolute",
    left: -4,
    top: -4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "rgba(120, 200, 255, 0.95)",
  },
  titleRow: { flexDirection: "row", alignItems: "center" },
  icon: { marginRight: 3 },
  title: { color: "#EAF6FF", fontSize: 12, fontWeight: "600" },
  sub: { color: "#9FC7E0", fontSize: 10 },
  leader: {
    position: "absolute",
    width: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(120, 200, 255, 0.5)",
  },
});

export const AircraftLabel = memo(AircraftLabelBase);
