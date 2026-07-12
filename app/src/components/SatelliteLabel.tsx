/**
 * A single absolutely-positioned satellite label in the AR overlay's orbital pass.
 *
 * Structurally mirrors VesselLabel (icon + title + a compact sub line, leader line when
 * decluttered) but is INTERACTIVE like AircraftLabel — a Pressable that opens the detail sheet on
 * tap (Phase 5). Its own violet family sets satellites apart from the blue aircraft and teal ships.
 * GNSS members (the dense, ever-present nav constellations) render dimmed so the crewed/amateur
 * stations you can actually work stay visually dominant.
 */

import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { SatelliteView } from "@/ar";

// Violet family — a third accent distinct from aircraft blue (#78C8FF) and vessel teal (#3FC9B0).
const SAT_VIOLET = "#C792EA";

export interface SatelliteLabelProps {
  satellite: SatelliteView;
  /** Pixel x of the projected point (label anchor). */
  x: number;
  /** Pixel y after declutter. */
  y: number;
  /** Original anchor y before the declutter push, for the leader line back to the true point. */
  anchorY: number;
  onPress: (noradId: number) => void;
}

function SatelliteLabelBase({ satellite, x, y, anchorY, onPress }: SatelliteLabelProps) {
  const isGnss = satellite.group === "gnss";
  const title = satellite.name.trim() || String(satellite.noradId);
  const el = `${Math.round(satellite.elevationDeg)}°`;
  const sub = satellite.freqSummary ? `${el}  ${satellite.freqSummary}` : el;
  const pushed = Math.abs(y - anchorY) > 1;

  return (
    <>
      {pushed && (
        <View
          style={[
            styles.leader,
            { left: x, top: Math.min(anchorY, y), height: Math.abs(y - anchorY) },
          ]}
        />
      )}
      <Pressable
        testID={`sat-label-${satellite.noradId}`}
        onPress={() => onPress(satellite.noradId)}
        style={[styles.label, isGnss && styles.gnss, { left: x, top: y }]}
        hitSlop={8}
      >
        <View style={styles.tick} />
        <View style={styles.titleRow}>
          <MaterialCommunityIcons
            testID={`sat-icon-${satellite.noradId}`}
            name="satellite-variant"
            size={13}
            color={SAT_VIOLET}
            style={styles.icon}
          />
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <Text style={styles.sub} numberOfLines={1}>
          {sub}
        </Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  label: {
    position: "absolute",
    transform: [{ translateX: -6 }, { translateY: -6 }],
    // Dark, faintly violet-tinted backing so the orbital labels sit apart from the blue/teal chips.
    backgroundColor: "rgba(20, 12, 32, 0.72)",
    borderColor: "rgba(199, 146, 234, 0.8)",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    maxWidth: 170,
  },
  // GNSS: dim the whole chip so the dense nav constellations recede behind stations/amateur/weather.
  gnss: {
    opacity: 0.55,
  },
  tick: {
    position: "absolute",
    left: -4,
    top: -4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: SAT_VIOLET,
  },
  titleRow: { flexDirection: "row", alignItems: "center" },
  icon: { marginRight: 3 },
  title: { color: "#EDE3FA", fontSize: 12, fontWeight: "600" },
  sub: { color: "#C3A9E0", fontSize: 10 },
  leader: {
    position: "absolute",
    width: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(199, 146, 234, 0.5)",
    pointerEvents: "none",
  },
});

export const SatelliteLabel = memo(SatelliteLabelBase);
