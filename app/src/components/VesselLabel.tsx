/**
 * A single absolutely-positioned vessel label rendered in the AR surface band over the camera
 * preview. Position comes from the overlay (already converted to pixels and offset down into the
 * band). Marine styling — a teal/cyan family distinct from the blue AircraftLabel, tinted per class
 * by iconForVessel — so ships read as clearly "not aircraft".
 *
 * Only the title row (icon + name) is tappable, and only when `onPress` is given: it opens the vessel
 * detail sheet, like tapping an aircraft label. The rest of the chip (range/speed line, border, leader)
 * stays pass-through (pointerEvents box-none). The AR surface band is dense — many labels crowd a narrow
 * horizon strip — so a whole-chip target with a generous hitSlop, as aircraft labels have, would mostly
 * produce mis-taps and steal taps from the camera / drag-to-look behind it. The labels are already
 * decluttered (no two overlap), and aircraft labels render on top, so they win where the two meet.
 */

import { alpha, color } from "@/theme";
import { textHalo } from "./textHalo";
import { memo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
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
  /** Tapping the icon/name opens the vessel's detail sheet. Omit for a display-only label. */
  onPress?: (mmsi: string) => void;
}

/** Small, so neighbouring labels in the band don't steal each other's taps. */
const NAME_HIT_SLOP = { top: 4, bottom: 4, left: 4, right: 4 };

/**
 * The icon + name row: a Pressable when the label is selectable, else a plain View (pass-through).
 */
function TitleRow({
  mmsi,
  title,
  onPress,
  children,
}: {
  mmsi: string;
  title: string;
  onPress?: (mmsi: string) => void;
  children: ReactNode;
}) {
  if (!onPress) return <View style={styles.titleRow}>{children}</View>;
  return (
    <Pressable
      testID={`ves-name-${mmsi}`}
      accessibilityRole="button"
      accessibilityLabel={`Open details for ${title}`}
      onPress={() => onPress(mmsi)}
      hitSlop={NAME_HIT_SLOP}
      style={styles.titleRow}
    >
      {children}
    </Pressable>
  );
}

function VesselLabelBase({ vessel, x, y, anchorY, rangeKm, onPress }: VesselLabelProps) {
  const { name: iconName, color, tag } = iconForVessel(vessel);
  const isAton = vessel.kind === "aton";
  const isVirtualAton = isAton && !!vessel.virtual;
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
          style={[
            styles.label,
            styles.aton,
            { left: x, top: y, borderColor: color },
            isVirtualAton && styles.atonVirtual,
          ]}
        >
          <TitleRow mmsi={vessel.mmsi} title={title} onPress={onPress}>
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
          </TitleRow>
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
        <TitleRow mmsi={vessel.mmsi} title={title} onPress={onPress}>
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
          {tag ? (
            <Text style={[styles.classTag, { backgroundColor: color }]}>{tag}</Text>
          ) : null}
        </TitleRow>
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
    backgroundColor: "rgba(6, 26, 30, 0.9)",
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    maxWidth: 150,
    // box-none: the chip itself passes touches through; only the TitleRow Pressable (when the label
    // is selectable) receives them. A display-only label has no touchable child, so it stays fully
    // pass-through as before.
    pointerEvents: "box-none",
  },
  aton: {
    opacity: 0.9,
    maxWidth: 120,
    backgroundColor: "rgba(6, 26, 30, 0.85)",
  },
  // sea = square — a colourblind-safe shape, distinct from the aircraft circle.
  tick: {
    position: "absolute",
    left: -4,
    top: -4,
    width: 8,
    height: 8,
    borderRadius: 0,
  },
  // The row is the tap target: let the name ellipsize inside it instead of overflowing the chip.
  titleRow: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", maxWidth: "100%" },
  icon: { marginRight: 3 },
  title: {
    color: "#CFF6EE",
    fontSize: 12,
    fontWeight: "600",
    flexShrink: 1,
    ...textHalo,
  },
  atonTitle: { color: "#EDE0B8", fontSize: 10, fontWeight: "500" },
  // Virtual AtoN: a dashed chip vs the physical aid's solid border — shape redundancy so the phantom
  // mark survives greyscale, not the magenta hue alone.
  atonVirtual: { borderStyle: "dashed" },
  // Ship-class tag badge (H/P/C/T): triple-codes the ferry family — hue + square tick + letter.
  classTag: {
    fontSize: 9,
    fontWeight: "700",
    color: color.bg,
    borderRadius: 3,
    paddingHorizontal: 3,
    marginLeft: 4,
    overflow: "hidden",
  },
  sub: {
    color: "#B6E8DD",
    fontSize: 11,
    ...textHalo,
  },
  leader: {
    position: "absolute",
    width: 1,
    backgroundColor: alpha(color.entity.sea, 0.7),
    pointerEvents: "none",
  },
});

export const VesselLabel = memo(VesselLabelBase);
