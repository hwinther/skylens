/**
 * The AR overlay: a full-screen absolute layer over the camera preview that, on
 * every animation frame, reads the current pose + observer position from refs,
 * dead-reckons each aircraft to "now", projects it through the pinhole model,
 * declutters the labels, and renders them. Nothing here touches zustand per frame —
 * the aircraft list is passed in (updated at 1 Hz) and the pose comes from refs.
 */

import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import {
  declutter,
  lookAngles,
  project,
  type CameraPose,
  type GeoPoint,
  type ProjectionConfig,
  type ScreenLabel,
} from "@/ar";
import type { AircraftDto } from "@/api/types";
import { AircraftLabel } from "./AircraftLabel";
import { deadReckon } from "@/ar/smoothing";

export interface ArOverlayProps {
  aircraft: AircraftDto[];
  /** Epoch ms the aircraft snapshot was received (for dead-reckoning age). */
  snapshotAt: number;
  poseRef: React.MutableRefObject<CameraPose>;
  positionRef: React.MutableRefObject<GeoPoint | null>;
  hFovDeg: number;
  onSelect: (hex: string) => void;
  /** Draw synthetic orientation aids — horizon, ground plane, and cardinal (N/E/S/W) hints —
   *  when there's no camera feed to orient against. */
  showHorizon?: boolean;
}

interface RenderLabel {
  aircraft: AircraftDto;
  x: number;
  y: number;
  anchorY: number;
  rangeKm: number | null;
}

interface RenderArrow {
  hex: string;
  bearingDeg: number;
}

interface CardinalMark {
  label: string;
  x: number;
  primary: boolean;
}

/** Cardinal points to hint on the horizon. N/S are emphasised; E/W are lighter. */
const CARDINALS: { label: string; az: number; primary: boolean }[] = [
  { label: "N", az: 0, primary: true },
  { label: "E", az: 90, primary: false },
  { label: "S", az: 180, primary: true },
  { label: "W", az: 270, primary: false },
];

export function ArOverlay({
  aircraft,
  snapshotAt,
  poseRef,
  positionRef,
  hFovDeg,
  onSelect,
  showHorizon = false,
}: ArOverlayProps) {
  const { width, height } = useWindowDimensions();
  const [labels, setLabels] = useState<RenderLabel[]>([]);
  const [arrows, setArrows] = useState<RenderArrow[]>([]);
  const [clusters, setClusters] = useState<{ x: number; y: number; count: number }[]>([]);
  // Screen y (px) of the elevation-0 horizon at the current pose; null when not shown.
  const [horizonY, setHorizonY] = useState<number | null>(null);
  // Cardinal-point hints (N/E/S/W) that are within the horizontal FOV this frame.
  const [cardinals, setCardinals] = useState<CardinalMark[]>([]);

  // Keep the latest inputs in refs so the rAF loop (started once) reads fresh data.
  // Syncing happens in an effect (not during render) so ref writes stay side-effects.
  const aircraftRef = useRef(aircraft);
  const snapshotAtRef = useRef(snapshotAt);
  const hFovRef = useRef(hFovDeg);
  const showHorizonRef = useRef(showHorizon);
  useEffect(() => {
    aircraftRef.current = aircraft;
    snapshotAtRef.current = snapshotAt;
    hFovRef.current = hFovDeg;
    showHorizonRef.current = showHorizon;
  }, [aircraft, snapshotAt, hFovDeg, showHorizon]);

  useEffect(() => {
    let raf = 0;
    let lastRun = 0;
    // Cap the overlay's heavy work (reprojecting N aircraft + declutter + the label-tree
    // re-render) at ~20 fps. The rAF keeps firing at display rate, but doing all that 60x/s
    // pins the JS thread the moment planes are present — starving touch handling and the pose
    // loop (the "frozen, can't tap, planes stuck as arrows" symptom). 20 fps still tracks the sky.
    const MIN_INTERVAL_MS = 1000 / 20;
    const config: ProjectionConfig = {
      hFovDeg: hFovRef.current,
      aspect: width / height,
      cullMargin: 0.15,
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const nowMs = Date.now();
      if (nowMs - lastRun < MIN_INTERVAL_MS) return;
      lastRun = nowMs;

      const pose = poseRef.current;
      const observer = positionRef.current;
      config.hFovDeg = hFovRef.current;
      config.aspect = width / height;

      const nextLabels: RenderLabel[] = [];
      const nextArrows: RenderArrow[] = [];
      const screenLabels: ScreenLabel[] = [];

      if (observer) {
        const ageS = Math.max(0, (Date.now() - snapshotAtRef.current) / 1000);
        for (const ac of aircraftRef.current) {
          if (ac.lat == null || ac.lon == null) continue;
          const alt = (ac.alt ?? 0) * 0.3048; // ft → m
          const dr = deadReckon(
            { lat: ac.lat, lon: ac.lon, alt, gs: ac.gs ?? 0, trk: ac.trk ?? 0, vr: ac.vr ?? 0 },
            ageS,
          );
          const angles = lookAngles(observer, { lat: dr.lat, lon: dr.lon, alt: dr.alt });
          const proj = project(
            { azimuth: angles.azimuth, elevation: angles.elevation },
            pose,
            config,
          );
          const px = (proj.xNdc * width) / 2 + width / 2;
          const py = height / 2 - (proj.yNdc * height) / 2;
          if (proj.onScreen) {
            screenLabels.push({
              id: ac.hex,
              x: px,
              y: py,
              priority: 1 / Math.max(angles.slantRange, 1), // closer = higher
            });
            nextLabels.push({
              aircraft: ac,
              x: px,
              y: py,
              anchorY: py,
              rangeKm: angles.slantRange / 1000,
            });
          } else if (proj.arrowBearingDeg != null) {
            nextArrows.push({ hex: ac.hex, bearingDeg: proj.arrowBearingDeg });
          }
        }
      }

      const { placed, clusters: chips } = declutter(screenLabels);
      const placedById = new Map(placed.map((p) => [p.id, p]));
      const decluttered = nextLabels
        .filter((l) => placedById.has(l.aircraft.hex))
        .map((l) => {
          const p = placedById.get(l.aircraft.hex)!;
          return { ...l, y: p.y, anchorY: p.anchorY };
        });

      setLabels(decluttered);
      setArrows(nextArrows);
      setClusters(chips.map((c) => ({ x: c.x, y: c.y, count: c.count })));

      // Synthetic horizon + compass. Pose-only (no observer needed), so it orients you even
      // before a GPS fix. Cardinal points sit on the horizon (elevation 0) at their azimuth,
      // and are shown only while inside the horizontal FOV.
      if (showHorizonRef.current) {
        const h = project({ azimuth: pose.azimuth, elevation: 0 }, pose, config);
        setHorizonY(height / 2 - (h.yNdc * height) / 2);

        const marks: CardinalMark[] = [];
        for (const c of CARDINALS) {
          const p = project({ azimuth: c.az, elevation: 0 }, pose, config);
          if (!p.behind && Math.abs(p.xNdc) <= 1) {
            marks.push({ label: c.label, x: (p.xNdc * width) / 2 + width / 2, primary: c.primary });
          }
        }
        setCardinals(marks);
      }

    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [width, height, poseRef, positionRef]);

  return (
    <View style={[StyleSheet.absoluteFill, { pointerEvents: "box-none" }]}>
      {showHorizon && horizonY != null && (
        <>
          <View
            testID="ar-ground"
            style={[styles.ground, { top: Math.max(0, Math.min(height, horizonY)) }]}
          />
          {horizonY >= 0 && horizonY <= height && (
            <View testID="ar-horizon" style={[styles.horizon, { top: horizonY }]} />
          )}
          {cardinals.map((c) => (
            <Text
              key={c.label}
              testID={`compass-${c.label}`}
              style={[
                styles.cardinal,
                c.primary && styles.cardinalPrimary,
                { left: c.x - 10, top: horizonY + 4 },
              ]}
            >
              {c.label}
            </Text>
          ))}
        </>
      )}
      {labels.map((l) => (
        <AircraftLabel
          key={l.aircraft.hex}
          aircraft={l.aircraft}
          x={l.x}
          y={l.y}
          anchorY={l.anchorY}
          rangeKm={l.rangeKm}
          onPress={onSelect}
        />
      ))}
      {clusters.map((c, i) => (
        <View key={`cl${i}`} style={[styles.cluster, { left: c.x, top: c.y }]}>
          <Text style={styles.clusterText}>+{c.count}</Text>
        </View>
      ))}
      {arrows.map((a) => (
        <View
          key={`ar${a.hex}`}
          testID={`ac-arrow-${a.hex}`}
          style={[styles.arrow, arrowPosition(a.bearingDeg, width, height)]}
        >
          <Text style={styles.arrowText}>▲</Text>
        </View>
      ))}
    </View>
  );
}

/** Place an off-screen arrow at the frame edge along the given screen bearing. */
function arrowPosition(bearingDeg: number, width: number, height: number) {
  const rad = (bearingDeg * Math.PI) / 180;
  const cx = width / 2;
  const cy = height / 2;
  const margin = 28;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const x = cx + dx * (width / 2 - margin);
  const y = cy + dy * (height / 2 - margin);
  return { left: x - 12, top: y - 12, transform: [{ rotate: `${bearingDeg}deg` }] };
}

const styles = StyleSheet.create({
  // Earthy fill below the horizon so "down" is obvious against the navy "sky" when there's
  // no camera; the horizon line is the level reference you tilt against.
  ground: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(20, 46, 30, 0.7)",
    pointerEvents: "none",
  },
  horizon: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: "rgba(120, 200, 255, 0.6)",
    pointerEvents: "none",
  },
  // Light cardinal hints on the horizon; N/S emphasised over E/W.
  cardinal: {
    position: "absolute",
    width: 20,
    textAlign: "center",
    color: "rgba(234, 246, 255, 0.5)",
    fontSize: 12,
    fontWeight: "600",
    pointerEvents: "none",
  },
  cardinalPrimary: {
    color: "rgba(234, 246, 255, 0.92)",
    fontSize: 13,
    fontWeight: "800",
  },
  cluster: {
    position: "absolute",
    backgroundColor: "rgba(255, 180, 80, 0.85)",
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    transform: [{ translateX: -12 }, { translateY: -10 }],
  },
  clusterText: { color: "#1a1a1a", fontSize: 11, fontWeight: "700" },
  arrow: { position: "absolute", width: 24, height: 24, alignItems: "center", justifyContent: "center", pointerEvents: "none" },
  arrowText: { color: "rgba(120, 200, 255, 0.9)", fontSize: 18 },
});
