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

export function ArOverlay({
  aircraft,
  snapshotAt,
  poseRef,
  positionRef,
  hFovDeg,
  onSelect,
}: ArOverlayProps) {
  const { width, height } = useWindowDimensions();
  const [labels, setLabels] = useState<RenderLabel[]>([]);
  const [arrows, setArrows] = useState<RenderArrow[]>([]);
  const [clusters, setClusters] = useState<{ x: number; y: number; count: number }[]>([]);

  // Keep the latest inputs in refs so the rAF loop (started once) reads fresh data.
  // Syncing happens in an effect (not during render) so ref writes stay side-effects.
  const aircraftRef = useRef(aircraft);
  const snapshotAtRef = useRef(snapshotAt);
  const hFovRef = useRef(hFovDeg);
  useEffect(() => {
    aircraftRef.current = aircraft;
    snapshotAtRef.current = snapshotAt;
    hFovRef.current = hFovDeg;
  }, [aircraft, snapshotAt, hFovDeg]);

  useEffect(() => {
    let raf = 0;
    const config: ProjectionConfig = {
      hFovDeg: hFovRef.current,
      aspect: width / height,
      cullMargin: 0.15,
    };

    const tick = () => {
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

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [width, height, poseRef, positionRef]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
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
          pointerEvents="none"
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
  cluster: {
    position: "absolute",
    backgroundColor: "rgba(255, 180, 80, 0.85)",
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    transform: [{ translateX: -12 }, { translateY: -10 }],
  },
  clusterText: { color: "#1a1a1a", fontSize: 11, fontWeight: "700" },
  arrow: { position: "absolute", width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  arrowText: { color: "rgba(120, 200, 255, 0.9)", fontSize: 18 },
});
