/**
 * A single absolutely-positioned airport label in the AR overlay's airports pass.
 *
 * Structurally mirrors SatelliteLabel — icon + title, a leader line when decluttered, and tappable
 * (a Pressable that opens the airport detail sheet) — but is deliberately dimmer and smaller: airports
 * are fixed infrastructure laid *under* the live traffic, not a target you're tracking. Its steel-blue
 * family (matching the map markers / detail sheet) sets it apart from the aircraft blue, vessel teal and
 * satellite violet. The title is the compact `airportShortLabel` (ICAO/IATA code, else the name's first
 * word for code-less community fields) — the roomier detail sheet carries the rest.
 */

import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { AirportDto } from "@/api/types";
import { AIRPORT_COLOR, AIRPORT_GLYPH, airportShortLabel } from "./webmap/airportStyle";

export interface AirportArLabelProps {
  airport: AirportDto;
  /** Pixel x of the projected point (label anchor). */
  x: number;
  /** Pixel y after declutter. */
  y: number;
  /** Original anchor y before the declutter push, for the leader line back to the true point. */
  anchorY: number;
  onPress: (ident: string) => void;
}

function AirportArLabelBase({ airport, x, y, anchorY, onPress }: AirportArLabelProps) {
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
        testID={`ar-airport-${airport.ident}`}
        onPress={() => onPress(airport.ident)}
        style={[styles.label, { left: x, top: y }]}
        hitSlop={8}
      >
        <View style={styles.tick} />
        <MaterialCommunityIcons
          testID={`ar-airport-icon-${airport.ident}`}
          name={AIRPORT_GLYPH}
          size={11}
          color={AIRPORT_COLOR}
          style={styles.icon}
        />
        <Text style={styles.title} numberOfLines={1}>
          {airportShortLabel(airport)}
        </Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  label: {
    position: "absolute",
    transform: [{ translateX: -6 }, { translateY: -6 }],
    flexDirection: "row",
    alignItems: "center",
    // Dimmer/smaller than the traffic chips — infrastructure, not a target. Steel-blue-tinted backing.
    opacity: 0.82,
    backgroundColor: "rgba(10, 20, 30, 0.66)",
    borderColor: "rgba(127, 166, 196, 0.7)",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 2,
    maxWidth: 120,
  },
  tick: {
    position: "absolute",
    left: -4,
    top: -4,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: AIRPORT_COLOR,
  },
  icon: { marginRight: 3 },
  title: { color: "#D3E3F0", fontSize: 11, fontWeight: "600" },
  leader: {
    position: "absolute",
    width: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(127, 166, 196, 0.45)",
    pointerEvents: "none",
  },
});

export const AirportArLabel = memo(AirportArLabelBase);
