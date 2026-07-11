/**
 * A single absolutely-positioned vessel label rendered in the AR surface band over the camera
 * preview. Position comes from the overlay (already converted to pixels and offset down into the
 * band). Marine styling — a teal/cyan family distinct from the blue AircraftLabel, tinted per class
 * by iconForVessel — so ships read as clearly "not aircraft".
 *
 * Display-only in this phase (pointerEvents: none): there's no vessel detail sheet yet, and the band
 * is dense, so taps pass straight through to aircraft labels / the camera. Mirrors the radar view,
 * whose vessel blips are likewise non-interactive.
 */

import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { VesselDto } from "@/api/types";
import { iconForVessel } from "./vesselIcon";

export interface VesselLabelProps {
  vessel: VesselDto;
  /** Pixel x of the projected horizon point (label anchor). */
  x: number;
  /** Pixel y after the band offset + declutter. */
  y: number;
  /** Band-anchored y before declutter push, for the leader line. */
  anchorY: number;
  /** Slant range in km, for the range line. */
  rangeKm: number | null;
}

function VesselLabelBase({ vessel, x, y, anchorY, rangeKm }: VesselLabelProps) {
  const { name: iconName, color } = iconForVessel(vessel);
  const isAton = vessel.kind === "aton";
  const title = vessel.name?.trim() || vessel.mmsi;
  const pushed = Math.abs(y - anchorY) > 1;

  const leader = pushed ? (
    <View
      style={[styles.leader, { left: x, top: Math.min(anchorY, y), height: Math.abs(y - anchorY) }]}
    />
  ) : null;

  if (isAton) {
    // AtoN: dimmer, smaller — just icon + name. No range/speed (they're fixed aids).
    return (
      <>
        {leader}
        <View
          testID={`ves-label-${vessel.mmsi}`}
          style={[styles.label, styles.aton, { left: x, top: y, borderColor: color }]}
        >
          <View style={styles.titleRow}>
            <MaterialCommunityIcons
              testID={`ves-icon-${vessel.mmsi}`}
              name={iconName}
              size={11}
              color={color}
              style={styles.icon}
            />
            <Text style={[styles.title, styles.atonTitle]} numberOfLines={1}>
              {title}
            </Text>
          </View>
        </View>
      </>
    );
  }

  const range = rangeKm != null ? `${rangeKm.toFixed(1)} km` : "";
  // AIS sog is in knots; only show it while genuinely under way (>0.5 kn), else it's berth noise.
  const moving = vessel.sog != null && vessel.sog > 0.5;
  const sog = moving ? `${vessel.sog!.toFixed(0)} kn` : "";
  const sub = [range, sog].filter(Boolean).join("  ");

  return (
    <>
      {leader}
      <View
        testID={`ves-label-${vessel.mmsi}`}
        style={[styles.label, { left: x, top: y, borderColor: color }]}
      >
        <View style={[styles.tick, { backgroundColor: color }]} />
        <View style={styles.titleRow}>
          <MaterialCommunityIcons
            testID={`ves-icon-${vessel.mmsi}`}
            name={iconName}
            size={13}
            color={color}
            style={styles.icon}
          />
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        </View>
        {sub ? (
          <Text style={styles.sub} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  label: {
    position: "absolute",
    transform: [{ translateX: -6 }, { translateY: -6 }],
    // Dark, faintly teal-tinted backing so the marine labels sit apart from the navy aircraft chips.
    backgroundColor: "rgba(6, 26, 30, 0.72)",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    maxWidth: 150,
    pointerEvents: "none",
  },
  aton: {
    opacity: 0.82,
    maxWidth: 120,
    backgroundColor: "rgba(6, 26, 30, 0.6)",
  },
  tick: {
    position: "absolute",
    left: -4,
    top: -4,
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  titleRow: { flexDirection: "row", alignItems: "center" },
  icon: { marginRight: 3 },
  title: { color: "#CFF6EE", fontSize: 12, fontWeight: "600" },
  atonTitle: { color: "#EDE0B8", fontSize: 10, fontWeight: "500" },
  sub: { color: "#8FD3C6", fontSize: 10 },
  leader: {
    position: "absolute",
    width: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(63, 201, 176, 0.5)",
    pointerEvents: "none",
  },
});

export const VesselLabel = memo(VesselLabelBase);
