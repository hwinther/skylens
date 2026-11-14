/**
 * Plan-position (radar) view: you at the centre, range rings + cardinal cross, and each positioned
 * aircraft plotted by bearing & distance as its type icon. Tapping a blip opens the detail sheet.
 *
 * Range: by default the outer ring auto-scales to the farthest blip, so a harbour cluster collapses
 * into the centre. The zoom control (`rangeKm` + `onRangeChange`) locks the ring to a fixed range so
 * those blips separate; targets beyond the ring pin to its edge (dimmed) at their true bearing.
 *
 * Tilt (`tiltDeg` + `onTiltChange`): the tilt control swings the scope into an oblique view and, from
 * the first tilt on, fetches a coarse elevation grid for the area (useRadarTerrain) that is drawn as
 * a land tint, the coastline and east–west ridge profiles raised to their height, so the tilted scope
 * reads as simplified relief (coastline, fjords, valleys, mountains). Everything — terrain, rings, labels, blips and their tap targets —
 * goes through one RadarProjection (src/radar/projection.ts). Flat (0°) is the classic plain-View scope,
 * unchanged. The terrain geometry is built once per grid / range / position; a tilt change only
 * re-projects it.
 *
 * Rotation (useRadarRotation): a horizontal drag on the scope turns it around the observer, who stays at
 * the centre. The view bearing goes into the same projection, so rings, compass marks (kept upright),
 * blips, leaders and the relief all turn together; the land and coast just re-project, the ridge
 * profiles are re-sampled across the new view direction every few degrees (painter's order). A small
 * "north up" button appears while the scope is turned. Session state, not persisted.
 */

import { alpha, color } from "@/theme";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { ApiClient } from "@/api/client";
import type { AircraftDto, AirportDto, VesselDto } from "@/api/types";
import {
  SCOPE_PADDING_PX,
  boxAt,
  makeRadarProjection,
  polarToKm,
  projectPoint,
  type RadarProjection,
} from "@/radar/projection";
import { ridgeBearingFor, rimLabelBox } from "@/radar/rotation";
import { buildTerrainBase, buildTerrainRidges, ridgeRowsFor, smoothLand } from "@/radar/terrainGeometry";
import { terrainPaths } from "@/radar/terrainPaths";
import { gridOffsetKm, heightAtKm } from "@/radar/terrainGrid";
import { aircraftAccent, iconForCategory } from "./aircraftIcon";
import { iconForVessel } from "./vesselIcon";
import { EmptyState } from "./EmptyState";
import { isAutoRange, zoomIn, zoomOut } from "./radarRange";
import { RadarScopeSvg } from "./RadarScopeSvg";
import { RadarTiltControl } from "./RadarTiltControl";
import { useRadarRotation } from "./useRadarRotation";
import { useRadarTerrain } from "./useRadarTerrain";
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
  /** Extra right offset for the zoom control, e.g. while a side-panel detail card covers the edge. */
  controlsRightInset?: number;
  /** Scope tilt in degrees (0 = flat). */
  tiltDeg?: number;
  /** Called with the new tilt when the user changes it; omit to hide the tilt control (always flat). */
  onTiltChange?: (deg: number) => void;
  /** API client for the terrain grid; without it the tilted scope has no relief (demo mode needs none). */
  terrainClient?: ApiClient | null;
  /** Demo mode: the relief comes from the bundled sample instead of the API. */
  demoMode?: boolean;
}

/**
 * A thin rotated bar between two projected points — a course leader. A default horizontal View points
 * east (+x); rotating it about its centre by the segment's screen angle aims it from the blip to the tip.
 */
function RadarLeader({ x1, y1, x2, y2, color }: { x1: number; y1: number; x2: number; y2: number; color: string }) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  return (
    <View
      style={{
        position: "absolute",
        left: midX - len / 2,
        top: midY - 1,
        width: len,
        height: 2,
        backgroundColor: color,
        opacity: 0.8,
        borderRadius: 1,
        transform: [{ rotate: `${angle}deg` }],
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

/** Upright compass letters on a turned scope: a centred box this size, this far outside the rim. */
const CARDINAL_BOX = 16;
const CARDINAL_GAP = 10;
/** The north-up button sits under the tilt control (which is about 130 px tall). */
const NORTH_UP_TOP_UNDER_TILT = 142;

/** The observer's offset from the grid centre is quantised to this fraction of the range (no rebuild on jitter). */
const OFFSET_QUANTUM = 0.005;

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
  controlsRightInset = 0,
  tiltDeg = 0,
  onTiltChange,
  terrainClient = null,
  demoMode = false,
}: AircraftRadarProps) {
  const [size, setSize] = useState(0);
  const [boxWidth, setBoxWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize(Math.max(0, Math.min(width, height)));
    setBoxWidth(width);
  };
  // The scope is a centred square; only the part of the inset that reaches into it moves the control.
  const zoomShift = Math.max(0, controlsRightInset - (boxWidth - size) / 2);

  const rel = aircraft
    .filter((a) => a.lat != null && a.lon != null)
    .map((a) => ({ a, ...relativePosition(observer, a.lat!, a.lon!) }));
  const vesselRel = vessels
    .filter((v) => v.lat != null && v.lon != null)
    .map((v) => ({ v, ...relativePosition(observer, v.lat!, v.lon!) }));
  // Airports are fixed references, so they never drive the auto range (only live traffic does).
  const airportRel = airports.map((ap) => ({ ap, ...relativePosition(observer, ap.lat, ap.lon) }));
  // Nothing on the scope at all — show a quiet centred caption over the rings (see below).
  const scopeEmpty = rel.length === 0 && vesselRel.length === 0 && airportRel.length === 0;
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

  // Tilt: the persisted value, overridden by the live value while the control is being dragged.
  const [dragTilt, setDragTilt] = useState<number | null>(null);
  const tilt = onTiltChange ? (dragTilt ?? tiltDeg) : 0;
  const commitTilt = useCallback(
    (deg: number) => {
      setDragTilt(null);
      onTiltChange?.(deg);
    },
    [onTiltChange],
  );
  // Terrain is lazy: nothing is fetched until the scope has been tilted (this session, or a persisted tilt).
  const [terrainWanted, setTerrainWanted] = useState(tilt > 0);
  if (tilt > 0 && !terrainWanted) setTerrainWanted(true);
  const terrain = useRadarTerrain({
    client: terrainClient,
    observer,
    rangeKm: maxRange,
    enabled: terrainWanted && onTiltChange != null,
    demoMode,
  });
  const grid = terrain.grid;
  // Where the grid's centre sits relative to the observer, quantised so GPS jitter doesn't rebuild it.
  const offsetDx = grid ? quantise(gridOffsetKm(grid, observer).dx, maxRange) : 0;
  const offsetDy = grid ? quantise(gridOffsetKm(grid, observer).dy, maxRange) : 0;
  const radiusPx = size / 2 - SCOPE_PADDING_PX;
  const rotation = useRadarRotation(radiusPx);
  const bearing = rotation.bearing;
  const ridgeRows = ridgeRowsFor(radiusPx);
  // Land, coast and height range don't depend on the view bearing: built once per grid / range / position.
  const base = useMemo(
    () => (grid ? buildTerrainBase(grid, { dx: offsetDx, dy: offsetDy }, maxRange) : null),
    [grid, offsetDx, offsetDy, maxRange],
  );
  const smooth = useMemo(() => (grid ? smoothLand(grid.heights, grid.size) : null), [grid]);
  // The ridge rows run across the screen, so they are re-sampled for the view bearing — only while
  // tilted (the flat scope draws no relief), and during a drag only every RIDGE_BEARING_STEP_DEG;
  // terrainPaths keeps them registered in between.
  const ridgeBearing = tilt > 0 ? ridgeBearingFor(bearing) : 0;
  const ridgeSet = useMemo(
    () =>
      grid && smooth
        ? buildTerrainRidges(grid, { dx: offsetDx, dy: offsetDy }, maxRange, {
            ridgeRows,
            viewBearingDeg: ridgeBearing,
            smooth,
          })
        : null,
    [grid, smooth, offsetDx, offsetDy, maxRange, ridgeRows, ridgeBearing],
  );
  const geometry = useMemo(
    () => (base && ridgeSet ? { ...base, ...ridgeSet, capped: base.capped || ridgeSet.capped } : null),
    [base, ridgeSet],
  );
  const showTerrain = geometry != null && tilt > 0;
  const reliefMaxM = showTerrain ? geometry.maxM : 0;
  const projection: RadarProjection = useMemo(
    () => makeRadarProjection({ size, rangeKm: maxRange, tiltDeg: tilt, reliefMaxM, bearingDeg: bearing }),
    [size, maxRange, tilt, reliefMaxM, bearing],
  );
  const paths = useMemo(
    () => (showTerrain && size > 0 ? terrainPaths(geometry, projection) : null),
    [showTerrain, geometry, projection, size],
  );

  // Mouse-wheel zoom on web only (RN Views expose no onWheel — attach to the host DOM node directly).
  // Re-attaching when the reference ranges change keeps the closure current; the cost is negligible.
  const rootRef = useRef<ComponentRef<typeof View>>(null);
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

  const { cx, cy, R } = projection;
  const tilted = tilt > 0;

  /** Screen position of a target at a bearing/distance (pinned to the rim beyond the range), on the relief. */
  const place = (distanceKm: number, bearingDeg: number) => {
    const { xKm, yKm } = polarToKm(Math.min(distanceKm, maxRange), bearingDeg);
    const z = showTerrain && grid ? heightAtKm(grid, { dx: offsetDx, dy: offsetDy }, xKm, yKm) : 0;
    return { ...projectPoint(projection, xKm, yKm, z), xKm, yKm, z };
  };
  /** Tip of a course leader: `leadKm` (clamped to the range) along `courseDeg` from a placed target. */
  const leaderTip = (from: { xKm: number; yKm: number; z: number }, leadKm: number, courseDeg: number) => {
    const d = polarToKm(Math.min(leadKm, maxRange), courseDeg);
    return projectPoint(projection, from.xKm + d.xKm, from.yKm + d.yKm, from.z);
  };

  const inTarget = zoomIn(current, autoRange);
  const outTarget = zoomOut(current, autoRange);
  const canZoomIn = inTarget !== current;
  const canZoomOut = outTarget !== current;
  const rangeLabel = auto ? `Auto (${Math.round(maxRange)} km)` : `${maxRange} km`;

  const north = projectPoint(projection, 0, maxRange);
  const south = projectPoint(projection, 0, -maxRange);
  const east = projectPoint(projection, maxRange, 0);
  const west = projectPoint(projection, -maxRange, 0);
  const origin = place(0, 0);
  const rotated = bearing !== 0;
  // North up, the compass letters keep their hand-placed offsets (identical to the unrotated scope).
  // Turned: an upright centred box just outside the rim, pushed out from the centre.
  const cardinalBox = (pt: { x: number; y: number }) => rimLabelBox(pt, origin, CARDINAL_BOX, CARDINAL_GAP);
  // The flat scope's plain-View cross turns about its centre with the view (north at −bearing on screen).
  const axisTurn = rotated && !tilted ? { transform: [{ rotate: `${-bearing}deg` }] } : null;
  // The north-up needle points at the drawn N (on a tilted scope that is not exactly −bearing).
  const northAngle = (Math.atan2(north.x - origin.x, origin.y - north.y) * 180) / Math.PI;
  /** Blip taps, unless the press was really a rotation drag (see useRadarRotation). */
  const guard = (fn: () => void) => () => {
    if (!rotation.suppressPress()) fn();
  };

  return (
    <View testID="radar" ref={rootRef} style={styles.root} onLayout={onLayout}>
      {size > 0 && (
        <GestureDetector gesture={rotation.gesture}>
          <View testID="radar-scope" style={{ width: size, height: size }}>
            {/* Flat: the classic plain-View rings and cross. Tilted: they move into the SVG layer. */}
            {!tilted &&
              RINGS.map((f) => {
                const d = 2 * R * f;
                return (
                  <View
                    key={`ring-${f}`}
                    style={[
                      styles.ring,
                      { width: d, height: d, borderRadius: d / 2, left: cx - R * f, top: cy - R * f },
                    ]}
                  />
                );
              })}
            {!tilted && (
              <View style={[styles.axis, { left: cx - 0.5, top: cy - R, width: 1, height: 2 * R }, axisTurn]} />
            )}
            {!tilted && (
              <View style={[styles.axis, { left: cx - R, top: cy - 0.5, width: 2 * R, height: 1 }, axisTurn]} />
            )}
            {tilted && (
              <RadarScopeSvg size={size} projection={projection} rings={RINGS} rangeKm={maxRange} terrain={paths} />
            )}

            {/* Range labels on the spoke pointing up the screen, whichever way the scope is turned. */}
            {RINGS.map((f) => {
              const up = polarToKm(maxRange * f, bearing);
              const pt = projectPoint(projection, up.xKm, up.yKm);
              return (
                <Text key={`lbl-${f}`} style={[styles.rangeLabel, { left: pt.x + 3, top: pt.y - 13 }]}>
                  {Math.round(maxRange * f)} km
                </Text>
              );
            })}

            {rotated ? (
              <>
                <Text
                  testID="radar-cardinal-n"
                  style={[styles.cardinal, styles.cardinalBox, styles.cardinalPrimary, cardinalBox(north)]}
                >
                  N
                </Text>
                <Text style={[styles.cardinal, styles.cardinalBox, cardinalBox(east)]}>E</Text>
                <Text style={[styles.cardinal, styles.cardinalBox, styles.cardinalPrimary, cardinalBox(south)]}>S</Text>
                <Text style={[styles.cardinal, styles.cardinalBox, cardinalBox(west)]}>W</Text>
              </>
            ) : (
              <>
                <Text
                  testID="radar-cardinal-n"
                  style={[styles.cardinal, styles.cardinalPrimary, { left: north.x - 5, top: north.y - 17 }]}
                >
                  N
                </Text>
                <Text style={[styles.cardinal, { left: east.x + 3, top: east.y - 8 }]}>E</Text>
                <Text style={[styles.cardinal, styles.cardinalPrimary, { left: south.x - 4, top: south.y + 3 }]}>
                  S
                </Text>
                <Text style={[styles.cardinal, { left: west.x - 15, top: west.y - 8 }]}>W</Text>
              </>
            )}

            <View style={[styles.observer, { left: origin.x - 4, top: origin.y - 4 }]} />

            {/* Airport reference diamonds, drawn before the traffic blips. In-range only — a fixed reference
              is never pinned to the rim (that would lie about where it is). */}
            {airportRel.map(({ ap, distanceKm, bearingDeg }) => {
              if (distanceKm > maxRange) return null;
              const pt = place(distanceKm, bearingDeg);
              return (
                <Pressable
                  key={`apt-${ap.ident}`}
                  testID={`map-airport-${ap.ident}`}
                  onPress={guard(() => onSelectAirport?.(ap.ident))}
                  style={[styles.airport, boxAt(pt, 24)]}
                  hitSlop={6}
                >
                  <View style={styles.airportDiamond} />
                </Pressable>
              );
            })}

            {/* Course leaders under the blips: same physical km lead as the geographic maps, projected. */}
            {showCourseVectors &&
              rel.map(({ a, distanceKm, bearingDeg }) => {
                if (distanceKm > maxRange || a.trk == null || a.gs == null || a.gs < MIN_COURSE_SPEED_KN) {
                  return null;
                }
                const pt = place(distanceKm, bearingDeg);
                const tip = leaderTip(pt, leadDistanceKm(a.gs, AIRCRAFT_LEAD_SECONDS), a.trk);
                return (
                  <RadarLeader
                    key={`ac-course-${a.hex}`}
                    x1={pt.x}
                    y1={pt.y}
                    x2={tip.x}
                    y2={tip.y}
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
                const pt = place(distanceKm, bearingDeg);
                const tip = leaderTip(pt, leadDistanceKm(v.sog, SHIP_LEAD_SECONDS), course);
                return (
                  <RadarLeader
                    key={`ship-course-${v.mmsi}`}
                    x1={pt.x}
                    y1={pt.y}
                    x2={tip.x}
                    y2={tip.y}
                    color={SHIP_COURSE_COLOR}
                  />
                );
              })}

            {rel.map(({ a, distanceKm, bearingDeg }) => {
              const beyond = distanceKm > maxRange;
              const pt = place(distanceKm, bearingDeg);
              return (
                <Pressable
                  key={a.hex}
                  testID={`map-ac-${a.hex}`}
                  onPress={guard(() => onSelect(a.hex))}
                  style={[styles.blip, beyond && styles.blipBeyond, boxAt(pt, 24)]}
                  hitSlop={6}
                >
                  <MaterialCommunityIcons
                    name={iconForCategory(a.cat)}
                    size={18}
                    color={alpha(aircraftAccent(a), 0.95)}
                  />
                </Pressable>
              );
            })}

            {/* Vessel blips in their per-class maritime colour; tappable → the vessel detail sheet. */}
            {vesselRel.map(({ v, distanceKm, bearingDeg }) => {
              const beyond = distanceKm > maxRange;
              const pt = place(distanceKm, bearingDeg);
              const { name, color } = iconForVessel(v);
              return (
                <Pressable
                  key={v.mmsi}
                  testID={`map-ship-${v.mmsi}`}
                  onPress={guard(() => onSelectVessel?.(v.mmsi))}
                  style={[styles.blip, beyond && styles.blipBeyond, boxAt(pt, 24)]}
                  hitSlop={6}
                >
                  <MaterialCommunityIcons name={name} size={16} color={color} />
                </Pressable>
              );
            })}

            {/* The ETOPO credit, whenever the relief is drawn. */}
            {paths && grid ? (
              <Text testID="radar-terrain-attribution" style={styles.attribution}>
                Relief: {grid.attribution}
                {terrain.demo ? " · demo sample" : ""}
              </Text>
            ) : null}

            {/* Tilt control, top-left: drag up to tilt into the relief view, tap to toggle flat. */}
            {onTiltChange && <RadarTiltControl tiltDeg={tilt} onLive={setDragTilt} onCommit={commitTilt} />}

            {/* North up: only while the scope is turned. The needle points at the drawn N. */}
            {rotated && (
              <Pressable
                testID="radar-north-up"
                onPress={rotation.northUp}
                accessibilityRole="button"
                accessibilityLabel="North up"
                accessibilityHint="Turns the radar back to north up"
                hitSlop={6}
                style={[styles.northUp, { top: onTiltChange ? NORTH_UP_TOP_UNDER_TILT : 4 }]}
              >
                <MaterialCommunityIcons
                  name="navigation"
                  size={15}
                  color={alpha(color.text, 0.9)}
                  style={{ transform: [{ rotate: `${northAngle}deg` }] }}
                />
                <Text style={styles.northUpText}>N</Text>
              </Pressable>
            )}

            {/* Range-zoom control, top-right. `+` / `−` step the fixed ladder; the chip resets to Auto. */}
            {onRangeChange && (
              <View style={[styles.zoomControl, { pointerEvents: "box-none", right: 4 + zoomShift }]}>
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

            {/* Empty scope: a compact centred caption over the rings. absoluteFill + box-none, so it
              never eats a blip tap when traffic is present. */}
            {scopeEmpty ? <EmptyState compact icon="radar" title="No traffic in range" /> : null}
          </View>
        </GestureDetector>
      )}
    </View>
  );
}

/** Snaps an offset (km) to a step that scales with the range, so tiny moves reuse the same geometry. */
function quantise(km: number, rangeKm: number): number {
  const q = Math.max(rangeKm * OFFSET_QUANTUM, 0.01);
  return Math.round(km / q) * q;
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: 8 },
  ring: {
    position: "absolute",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(color.entity.air, 0.28),
    pointerEvents: "none",
  },
  axis: { position: "absolute", backgroundColor: alpha(color.entity.air, 0.18), pointerEvents: "none" },
  rangeLabel: { position: "absolute", color: alpha(color.textDim, 0.75), fontSize: 10, pointerEvents: "none" },
  cardinal: {
    position: "absolute",
    color: alpha(color.text, 0.5),
    fontSize: 12,
    fontWeight: "600",
    pointerEvents: "none",
  },
  cardinalPrimary: { color: alpha(color.text, 0.9), fontWeight: "800" },
  cardinalBox: { width: CARDINAL_BOX, height: CARDINAL_BOX, lineHeight: CARDINAL_BOX, textAlign: "center" },
  northUp: {
    position: "absolute",
    left: 4,
    width: 34,
    paddingVertical: 4,
    alignItems: "center",
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(color.entity.air, 0.35),
    backgroundColor: "rgba(18, 40, 61, 0.55)",
  },
  northUpText: { color: alpha(color.textDim, 0.95), fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
  observer: {
    position: "absolute",
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: color.status.ok,
    pointerEvents: "none",
  },
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
  attribution: {
    position: "absolute",
    left: 4,
    bottom: 2,
    color: alpha(color.textMuted, 0.95),
    fontSize: 9,
    pointerEvents: "none",
  },
  zoomControl: { position: "absolute", top: 4, right: 4, alignItems: "center", gap: 4 },
  rangeChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(color.entity.air, 0.35),
    backgroundColor: "rgba(18, 40, 61, 0.55)",
  },
  rangeChipText: { color: alpha(color.textDim, 0.95), fontSize: 11, fontWeight: "600" },
  zoomBtn: {
    width: 30,
    height: 30,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(color.entity.air, 0.35),
    backgroundColor: "rgba(18, 40, 61, 0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  zoomBtnDisabled: { opacity: 0.35 },
  zoomBtnText: { color: alpha(color.text, 0.9), fontSize: 20, fontWeight: "700", lineHeight: 22 },
});
