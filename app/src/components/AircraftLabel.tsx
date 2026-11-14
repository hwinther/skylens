/**
 * A single absolutely-positioned aircraft label rendered over the camera preview.
 * Position comes from the projection pipeline (already converted to pixels by the
 * overlay). Tapping it opens the detail sheet.
 *
 * A target whose signal is lost (src/ar/signalLost) stays at its last known direction but reads as
 * stale at a glance: the chip is dimmed with a dashed border, the anchor dot is hollow, the leader is
 * fainter, and the second line becomes "lost · 45 s".
 */

import { alpha, color } from "@/theme";
import { textHalo } from "./textHalo";
import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { AircraftDto } from "@/api/types";
import { formatAge, lostTag } from "@/ar/signalLost";
import { aircraftAccent, iconForAircraft } from "./aircraftIcon";
import { LabelPressable } from "./LabelPressable";

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
  /** Whole seconds since the last position when the signal is lost; null/omitted while it is live. */
  lostAgeS?: number | null;
  onPress: (hex: string) => void;
}

function AircraftLabelBase({ aircraft, x, y, anchorY, rangeKm, lostAgeS = null, onPress }: AircraftLabelProps) {
  const title = aircraft.flight?.trim() || aircraft.hex.toUpperCase();
  const fl = aircraft.fl != null ? `FL${String(aircraft.fl).padStart(3, "0")}` : "—";
  const range = rangeKm != null ? `${rangeKm.toFixed(1)} km` : "";
  const pushed = Math.abs(y - anchorY) > 1;
  // Military airframes swap the aircraft blue for the military orange and carry a MIL tag.
  const accent = aircraftAccent(aircraft);
  const lost = lostAgeS != null;

  return (
    <>
      {pushed && (
        <View
          style={[
            styles.leader,
            {
              left: x,
              top: Math.min(anchorY, y),
              height: Math.abs(y - anchorY),
              backgroundColor: alpha(accent, lost ? 0.35 : 0.7),
            },
          ]}
        />
      )}
      <LabelPressable
        testID={`ac-label-${aircraft.hex}`}
        onPress={() => onPress(aircraft.hex)}
        style={[styles.label, { left: x, top: y, borderColor: accent }, lost && styles.lost]}
        hitSlop={8}
        accessibilityLabel={lost ? `${title}, signal lost ${formatAge(lostAgeS)} ago` : undefined}
      >
        {lost ? (
          <View testID={`ar-ac-lost-${aircraft.hex}`} style={[styles.tick, styles.tickLost, { borderColor: accent }]} />
        ) : (
          <View style={[styles.tick, { backgroundColor: alpha(accent, 0.95) }]} />
        )}
        <View style={styles.titleRow}>
          <MaterialCommunityIcons
            testID={`ac-icon-${aircraft.hex}`}
            name={iconForAircraft(aircraft)}
            size={13}
            color={alpha(accent, 0.95)}
            style={styles.icon}
          />
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {aircraft.mil ? (
            <Text testID={`ac-mil-${aircraft.hex}`} style={[styles.milTag, { backgroundColor: accent }]}>
              MIL
            </Text>
          ) : null}
        </View>
        {lost ? (
          <Text style={[styles.sub, styles.subLost]} numberOfLines={1}>
            {lostTag(lostAgeS)}
          </Text>
        ) : (
          <Text style={styles.sub} numberOfLines={1}>
            {fl}
            {range ? `  ${range}` : ""}
          </Text>
        )}
      </LabelPressable>
    </>
  );
}

const styles = StyleSheet.create({
  label: {
    position: "absolute",
    transform: [{ translateX: -6 }, { translateY: -6 }],
    backgroundColor: "rgba(6, 13, 22, 0.9)",
    borderColor: color.entity.air,
    borderWidth: 1,
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
    backgroundColor: alpha(color.entity.air, 0.95),
  },
  // Signal lost: dimmed, dashed chip with a hollow anchor dot (shape, not just colour, carries it).
  lost: { opacity: 0.6, borderStyle: "dashed" },
  tickLost: { backgroundColor: color.bg, borderWidth: 1.5 },
  titleRow: { flexDirection: "row", alignItems: "center" },
  // Same badge shape as the vessel class tag (VesselLabel).
  milTag: {
    fontSize: 9,
    fontWeight: "700",
    color: color.bg,
    borderRadius: 3,
    paddingHorizontal: 3,
    marginLeft: 4,
    overflow: "hidden",
  },
  icon: { marginRight: 3 },
  title: {
    color: color.text,
    fontSize: 12,
    fontWeight: "600",
    ...textHalo,
  },
  sub: {
    color: "#CDE8FA",
    fontSize: 11,
    ...textHalo,
  },
  subLost: { color: color.status.warn, fontStyle: "italic" },
  leader: {
    position: "absolute",
    width: 1,
    backgroundColor: alpha(color.entity.air, 0.7),
    pointerEvents: "none",
  },
});

export const AircraftLabel = memo(AircraftLabelBase);
