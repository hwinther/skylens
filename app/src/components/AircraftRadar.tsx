/**
 * Plan-position (radar) view: you at the centre, range rings + cardinal cross, and each positioned
 * aircraft plotted by bearing & distance as its type icon. Pure react-native Views (no SVG, no map
 * tiles) so it works offline on web and native. Tapping a blip opens the detail sheet.
 *
 * Range: by default the outer ring auto-scales to the farthest blip, so a harbour cluster collapses
 * into the centre. The zoom control (`rangeKm` + `onRangeChange`) locks the ring to a fixed range so
 * those blips separate; targets beyond the ring pin to its edge (dimmed) at their true bearing.
 */

import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { AircraftDto, AirportDto, VesselDto } from "@/api/types";
import { iconForCategory } from "./aircraftIcon";
import { iconForVessel } from "./vesselIcon";
import { isAutoRange, zoomIn, zoomOut } from "./radarRange";
import { relativePosition, type Observer } from "./webmap/relative";
import { AIRPORT_COLOR } from "./webmap/airportStyle";
import {
  leadDistanceKm,
  AIRCRAFT_LEAD_SECONDS,
  SHIP_LEAD_SECONDS,
  AIRCRAFT_COURSE_COLOR,
  SHIP_COURSE_COLOR,
  MIN_COURSE_SPEED_KN,
} from "./webmap/course";

export interface AircraftRadarProps {
  aircraft: AircraftDto[];
  observer: Observer;
  onSelect: (hex: string) => void;
  /** AIS vessels to plot alongside aircraft; already filtered to the visible kinds by the caller. */
  vessels?: VesselDto[];
  /** Tap handler for a vessel blip (opens the vessel detail sheet). Blips are inert when omitted. */
  onSelectVessel?: (mmsi: string) => void;
  /** Airports to plot as fixed reference diamonds; already filtered by the caller. */
  airports?: AirportDto[];
  /** Tap handler for an airport diamond (opens the airport detail sheet). Diamonds inert when omitted. */
  onSelectAirport?: (ident: string) => void;
  /** Fixed outer-ring range in km; `0`/undefined = auto-scale to the farthest blip. */
  rangeKm?: number;
  /** Called with the new range when the user zooms; omit to hide the zoom control (read-only radar). */
  onRangeChange?: (km: number) => void;
  /** Draw a short predicted-track (course/heading) leader ahead of moving aircraft & ships. */
  showCourseVectors?: boolean;
}

/**
 * A thin rotated bar from a blip toward its heading — the radar's pixel projection of the physical km
 * leader. A default horizontal View points east (+x); rotating by `bearingDeg - 90` about its centre
 * aims it along the true bearing (0 = N → up). Centred on the blip→endpoint midpoint so it spans the leg.
 */
function RadarLeader({
  x,
  y,
  leadPx,
  bearingDeg,
  color,
}: {
  x: number;
  y: number;
  leadPx: number;
  bearingDeg: number;
  color: string;
}) {
  const rad = (bearingDeg * Math.PI) / 180;
  const ex = x + leadPx * Math.sin(rad);
  const ey = y - leadPx * Math.cos(rad);
  const midX = (x + ex) / 2;
  const midY = (y + ey) / 2;
  return (
    <View
      style={{
        position: "absolute",
        left: midX - leadPx / 2,
        top: midY - 1,
        width: leadPx,
        height: 2,
        backgroundColor: color,
        opacity: 0.8,
        borderRadius: 1,
        transform: [{ rotate: `${bearingDeg - 90}deg` }],
        pointerEvents: "none",
      }}
    />
  );
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
  airports = [],
  onSelectAirport,
  rangeKm,
  onRangeChange,
  showCourseVectors = false,
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
  // Airports are fixed references, so they never drive the auto range (only live traffic does).
  const airportRel = airports.map((ap) => ({ ap, ...relativePosition(observer, ap.lat, ap.lon) }));
  // The auto range: scaled to the farthest thing on screen — aircraft or ship — so nothing clips it.
  const autoRange = niceMax(
    Math.max(
      rel.reduce((m, r) => Math.max(m, r.distanceKm), 0),
      vesselRel.reduce((m, r) => Math.max(m, r.distanceKm), 0),
    ),
  );
  const auto = isAutoRange(rangeKm);
  // A manual range is already a tidy preset value — use it exactly, no niceMax rounding.
  const maxRange = auto ? autoRange : (rangeKm as number);

  // Mouse-wheel zoom on web only (RN Views expose no onWheel — attach to the host DOM node directly).
  // Re-attaching when the reference ranges change keeps the closure current; the cost is negligible.
  const rootRef = useRef<View>(null);
  const current = auto ? 0 : (rangeKm as number);
  useEffect(() => {
    if (Platform.OS !== "web" || !onRangeChange) return;
    const node = rootRef.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== "function") return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      const next = e.deltaY > 0 ? zoomOut(current, autoRange) : zoomIn(current, autoRange);
      if (next !== current) onRangeChange(next);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [current, autoRange, onRangeChange]);

  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 18;

  const inTarget = zoomIn(current, autoRange);
  const outTarget = zoomOut(current, autoRange);
  const canZoomIn = inTarget !== current;
  const canZoomOut = outTarget !== current;
  const rangeLabel = auto ? `Auto (${Math.round(maxRange)} km)` : `${maxRange} km`;

  return (
    <View ref={rootRef} style={styles.root} onLayout={onLayout}>
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

          {/* Airport reference diamonds, drawn before the traffic blips. In-range only — a fixed reference
              is never pinned to the rim (that would lie about where it is). */}
          {airportRel.map(({ ap, distanceKm, bearingDeg }) => {
            if (distanceKm > maxRange) return null;
            const rr = Math.min(distanceKm / maxRange, 1) * R;
            const rad = (bearingDeg * Math.PI) / 180;
            const x = cx + rr * Math.sin(rad);
            const y = cy - rr * Math.cos(rad);
            return (
              <Pressable
                key={`apt-${ap.ident}`}
                testID={`map-airport-${ap.ident}`}
                onPress={() => onSelectAirport?.(ap.ident)}
                style={[styles.airport, { left: x - 12, top: y - 12 }]}
                hitSlop={6}
              >
                <View style={styles.airportDiamond} />
              </Pressable>
            );
          })}

          {/* Course leaders under the blips: same physical km lead as the geographic maps, in px. */}
          {showCourseVectors &&
            rel.map(({ a, distanceKm, bearingDeg }) => {
              if (distanceKm > maxRange || a.trk == null || a.gs == null || a.gs < MIN_COURSE_SPEED_KN) {
                return null;
              }
              const rr = Math.min(distanceKm / maxRange, 1) * R;
              const rad = (bearingDeg * Math.PI) / 180;
              const x = cx + rr * Math.sin(rad);
              const y = cy - rr * Math.cos(rad);
              // Clamp so a fast target at close range doesn't shoot the leader off the scope.
              const leadPx = Math.min(leadDistanceKm(a.gs, AIRCRAFT_LEAD_SECONDS) * (R / maxRange), R);
              return (
                <RadarLeader
                  key={`ac-course-${a.hex}`}
                  x={x}
                  y={y}
                  leadPx={leadPx}
                  bearingDeg={a.trk}
                  color={AIRCRAFT_COURSE_COLOR}
                />
              );
            })}
          {showCourseVectors &&
            vesselRel.map(({ v, distanceKm, bearingDeg }) => {
              const course = v.cog ?? v.hdg;
              if (
                distanceKm > maxRange ||
                v.kind !== "ship" ||
                course == null ||
                v.sog == null ||
                v.sog < MIN_COURSE_SPEED_KN
              ) {
                return null;
              }
              const rr = Math.min(distanceKm / maxRange, 1) * R;
              const rad = (bearingDeg * Math.PI) / 180;
              const x = cx + rr * Math.sin(rad);
              const y = cy - rr * Math.cos(rad);
              const leadPx = Math.min(leadDistanceKm(v.sog, SHIP_LEAD_SECONDS) * (R / maxRange), R);
              return (
                <RadarLeader
                  key={`ship-course-${v.mmsi}`}
                  x={x}
                  y={y}
                  leadPx={leadPx}
                  bearingDeg={course}
                  color={SHIP_COURSE_COLOR}
                />
              );
            })}

          {rel.map(({ a, distanceKm, bearingDeg }) => {
            const beyond = distanceKm > maxRange;
            const rr = Math.min(distanceKm / maxRange, 1) * R;
            const rad = (bearingDeg * Math.PI) / 180;
            const x = cx + rr * Math.sin(rad);
            const y = cy - rr * Math.cos(rad);
            return (
              <Pressable
                key={a.hex}
                testID={`map-ac-${a.hex}`}
                onPress={() => onSelect(a.hex)}
                style={[styles.blip, beyond && styles.blipBeyond, { left: x - 12, top: y - 12 }]}
                hitSlop={6}
              >
                <MaterialCommunityIcons name={iconForCategory(a.cat)} size={18} color="rgba(120, 200, 255, 0.95)" />
              </Pressable>
            );
          })}

          {/* Vessel blips in their per-class maritime colour; tappable → the vessel detail sheet. */}
          {vesselRel.map(({ v, distanceKm, bearingDeg }) => {
            const beyond = distanceKm > maxRange;
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
                style={[styles.blip, beyond && styles.blipBeyond, { left: x - 12, top: y - 12 }]}
                hitSlop={6}
              >
                <MaterialCommunityIcons name={name} size={16} color={color} />
              </Pressable>
            );
          })}

          {/* Range-zoom control, top-right. `+` / `−` step the fixed ladder; the chip resets to Auto. */}
          {onRangeChange && (
            <View style={[styles.zoomControl, { pointerEvents: "box-none" }]}>
              <Pressable
                testID="radar-range-label"
                onPress={() => onRangeChange(0)}
                style={styles.rangeChip}
                hitSlop={4}
              >
                <Text style={styles.rangeChipText}>{rangeLabel}</Text>
              </Pressable>
              <Pressable
                testID="radar-zoom-in"
                onPress={() => canZoomIn && onRangeChange(inTarget)}
                disabled={!canZoomIn}
                style={[styles.zoomBtn, !canZoomIn && styles.zoomBtnDisabled]}
                hitSlop={4}
              >
                <Text style={styles.zoomBtnText}>+</Text>
              </Pressable>
              <Pressable
                testID="radar-zoom-out"
                onPress={() => canZoomOut && onRangeChange(outTarget)}
                disabled={!canZoomOut}
                style={[styles.zoomBtn, !canZoomOut && styles.zoomBtnDisabled]}
                hitSlop={4}
              >
                <Text style={styles.zoomBtnText}>−</Text>
              </Pressable>
            </View>
          )}
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
  // Beyond the fixed range: pinned to the outer ring at true bearing, dimmed so it reads as clamped.
  blipBeyond: { opacity: 0.4 },
  // Airport reference: a small hollow steel-blue diamond (a rotated square), dimmer than the traffic blips.
  airport: { position: "absolute", width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  airportDiamond: {
    width: 10,
    height: 10,
    borderWidth: 1.5,
    borderColor: AIRPORT_COLOR,
    opacity: 0.7,
    transform: [{ rotate: "45deg" }],
  },
  zoomControl: { position: "absolute", top: 4, right: 4, alignItems: "center", gap: 4 },
  rangeChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(120, 200, 255, 0.35)",
    backgroundColor: "rgba(18, 40, 61, 0.55)",
  },
  rangeChipText: { color: "rgba(159, 199, 224, 0.95)", fontSize: 11, fontWeight: "600" },
  zoomBtn: {
    width: 30,
    height: 30,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(120, 200, 255, 0.35)",
    backgroundColor: "rgba(18, 40, 61, 0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  zoomBtnDisabled: { opacity: 0.35 },
  zoomBtnText: { color: "rgba(234, 246, 255, 0.9)", fontSize: 20, fontWeight: "700", lineHeight: 22 },
});
