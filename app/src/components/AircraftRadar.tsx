/**
 * Plan-position (radar) view: you at the centre, range rings + cardinal cross, and each positioned
 * aircraft plotted by bearing & distance as its type icon. Pure react-native Views (no SVG, no map
 * tiles) so it works offline on web and native. Tapping a blip opens the detail sheet.
 */

import { useState } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { AircraftDto, VesselDto } from "@/api/types";
import { iconForCategory } from "./aircraftIcon";
import { iconForVessel } from "./vesselIcon";
import { relativePosition, type Observer } from "./webmap/relative";

export interface AircraftRadarProps {
  aircraft: AircraftDto[];
  observer: Observer;
  onSelect: (hex: string) => void;
  /** AIS vessels to plot alongside aircraft; already filtered to the visible kinds by the caller. */
  vessels?: VesselDto[];
  /** Tap handler for a vessel blip (opens the vessel detail sheet). Blips are inert when omitted. */
  onSelectVessel?: (mmsi: string) => void;
}

/** Round a range up to a tidy 1 / 2 / 5 × 10ⁿ value for the outer ring. */
function niceMax(km: number): number {
  const floor = Math.max(km, 5);
  const pow = 10 ** Math.floor(Math.log10(floor));
  const n = floor / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

const RINGS = [1 / 3, 2 / 3, 1];

export function AircraftRadar({
  aircraft,
  observer,
  onSelect,
  vessels = [],
  onSelectVessel,
}: AircraftRadarProps) {
  const [size, setSize] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize(Math.max(0, Math.min(width, height)));
  };

  const rel = aircraft
    .filter((a) => a.lat != null && a.lon != null)
    .map((a) => ({ a, ...relativePosition(observer, a.lat!, a.lon!) }));
  const vesselRel = vessels
    .filter((v) => v.lat != null && v.lon != null)
    .map((v) => ({ v, ...relativePosition(observer, v.lat!, v.lon!) }));
  // Range scaled to the farthest thing on screen — aircraft or ship — so nothing clips the ring.
  const maxRange = niceMax(
    Math.max(
      rel.reduce((m, r) => Math.max(m, r.distanceKm), 0),
      vesselRel.reduce((m, r) => Math.max(m, r.distanceKm), 0),
    ),
  );

  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 18;

  return (
    <View style={styles.root} onLayout={onLayout}>
      {size > 0 && (
        <View style={{ width: size, height: size }}>
          {RINGS.map((f) => {
            const d = 2 * R * f;
            return (
              <View
                key={`ring-${f}`}
                style={[styles.ring, { width: d, height: d, borderRadius: d / 2, left: cx - R * f, top: cy - R * f }]}
              />
            );
          })}
          <View style={[styles.axis, { left: cx - 0.5, top: cy - R, width: 1, height: 2 * R }]} />
          <View style={[styles.axis, { left: cx - R, top: cy - 0.5, width: 2 * R, height: 1 }]} />

          {RINGS.map((f) => (
            <Text key={`lbl-${f}`} style={[styles.rangeLabel, { left: cx + 3, top: cy - R * f - 13 }]}>
              {Math.round(maxRange * f)} km
            </Text>
          ))}

          <Text style={[styles.cardinal, styles.cardinalPrimary, { left: cx - 5, top: cy - R - 17 }]}>N</Text>
          <Text style={[styles.cardinal, { left: cx + R + 3, top: cy - 8 }]}>E</Text>
          <Text style={[styles.cardinal, styles.cardinalPrimary, { left: cx - 4, top: cy + R + 3 }]}>S</Text>
          <Text style={[styles.cardinal, { left: cx - R - 15, top: cy - 8 }]}>W</Text>

          <View style={[styles.observer, { left: cx - 4, top: cy - 4 }]} />

          {rel.map(({ a, distanceKm, bearingDeg }) => {
            const rr = Math.min(distanceKm / maxRange, 1) * R;
            const rad = (bearingDeg * Math.PI) / 180;
            const x = cx + rr * Math.sin(rad);
            const y = cy - rr * Math.cos(rad);
            return (
              <Pressable
                key={a.hex}
                testID={`map-ac-${a.hex}`}
                onPress={() => onSelect(a.hex)}
                style={[styles.blip, { left: x - 12, top: y - 12 }]}
                hitSlop={6}
              >
                <MaterialCommunityIcons name={iconForCategory(a.cat)} size={18} color="rgba(120, 200, 255, 0.95)" />
              </Pressable>
            );
          })}

          {/* Vessel blips in their per-class maritime colour; tappable → the vessel detail sheet. */}
          {vesselRel.map(({ v, distanceKm, bearingDeg }) => {
            const rr = Math.min(distanceKm / maxRange, 1) * R;
            const rad = (bearingDeg * Math.PI) / 180;
            const x = cx + rr * Math.sin(rad);
            const y = cy - rr * Math.cos(rad);
            const { name, color } = iconForVessel(v);
            return (
              <Pressable
                key={v.mmsi}
                testID={`map-ship-${v.mmsi}`}
                onPress={() => onSelectVessel?.(v.mmsi)}
                style={[styles.blip, { left: x - 12, top: y - 12 }]}
                hitSlop={6}
              >
                <MaterialCommunityIcons name={name} size={16} color={color} />
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: 8 },
  ring: { position: "absolute", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(120, 200, 255, 0.28)", pointerEvents: "none" },
  axis: { position: "absolute", backgroundColor: "rgba(120, 200, 255, 0.18)", pointerEvents: "none" },
  rangeLabel: { position: "absolute", color: "rgba(159, 199, 224, 0.75)", fontSize: 10, pointerEvents: "none" },
  cardinal: { position: "absolute", color: "rgba(234, 246, 255, 0.5)", fontSize: 12, fontWeight: "600", pointerEvents: "none" },
  cardinalPrimary: { color: "rgba(234, 246, 255, 0.9)", fontWeight: "800" },
  observer: { position: "absolute", width: 8, height: 8, borderRadius: 4, backgroundColor: "#7CFC9A", pointerEvents: "none" },
  blip: { position: "absolute", width: 24, height: 24, alignItems: "center", justifyContent: "center" },
});
