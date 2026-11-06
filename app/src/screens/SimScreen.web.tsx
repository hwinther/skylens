/**
 * Simulator / cockpit view (web): a Cesium globe with Esri World Imagery and terrain, the camera riding
 * the followed aircraft, vessel or satellite and looking along its direction of travel.
 *
 * Data flow:
 *  - aircraft / vessel: the shared live stores (useLiveFeed). While the session is active the root
 *    layout centres the hub subscription on the target (simStore), so it stays in the feed.
 *  - satellite: GET /api/satellites/{noradId} → one SGP4 satrec, propagated every frame.
 *  Each sample goes into a SimTracker, which dead-reckons and blends to a smooth 60 fps pose.
 *
 * Everything (Cesium widget, store subscriptions, the session itself) is tied to screen focus, not
 * mount: tabs stay mounted, and the subscription must go back to the observer when the user leaves.
 * Dragging adds a look offset to the direction of travel; a double click resets it.
 */

import { color } from "@/theme";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { SatRec } from "satellite.js";
import type { CesiumWidget } from "cesium";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl } from "@/api/config";
import { buildSatrec, satelliteStateAt } from "@/ar/satellites";
import { useAircraftStore } from "@/state/aircraftStore";
import { useVesselStore } from "@/state/vesselStore";
import { useSimStore, type SimTarget } from "@/state/simStore";
import { loadCesium } from "@/sim/loadCesium";
import {
  aircraftSample,
  FEET_TO_M,
  satelliteSample,
  vesselSample,
  type SimKind,
} from "@/sim/simPose";
import { SimTracker, type TrackedPose } from "@/sim/tracker";
import { KNOTS_TO_MPS } from "@/ar/smoothing";

const ESRI_IMAGERY_URL = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
const ESRI_TERRAIN_URL =
  "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";

/** HUD refresh rate; the camera itself updates every frame. */
const HUD_MS = 250;
/** Drag sensitivity, degrees per pixel. */
const LOOK_DEG_PER_PX = 0.15;
const MAX_LOOK_PITCH_DEG = 80;

const KINDS: readonly SimKind[] = ["aircraft", "vessel", "satellite"];

function parseTarget(kind: unknown, id: unknown): SimTarget | null {
  if (typeof kind !== "string" || typeof id !== "string" || !id) return null;
  return (KINDS as readonly string[]).includes(kind) ? { kind: kind as SimKind, id } : null;
}

interface Hud {
  pose: TrackedPose | null;
  name: string;
}

export default function SimScreen() {
  const params = useLocalSearchParams<{ kind?: string; id?: string }>();
  const target = useMemo(() => parseTarget(params.kind, params.id), [params.kind, params.id]);
  const router = useRouter();
  const start = useSimStore((s) => s.start);
  const stop = useSimStore((s) => s.stop);
  const setPosition = useSimStore((s) => s.setPosition);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const lookRef = useRef({ yaw: 0, pitch: 0 });
  const nameRef = useRef("");
  const [hud, setHud] = useState<Hud>({ pose: null, name: "" });
  const [error, setError] = useState<string | null>(null);
  const [engineReady, setEngineReady] = useState(false);

  const exit = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [router]);

  useFocusEffect(
    useCallback(() => {
      if (!target) return;
      const el = containerRef.current;
      if (!el) return;

      // (Re)start the session: also covers a reload or deep link straight to /sim.
      start(target);
      const tracker = new SimTracker();
      let cancelled = false;
      let widget: CesiumWidget | null = null;
      let satrec: SatRec | null = null;
      const cleanups: (() => void)[] = [];
      let lastPose: TrackedPose | null = null;

      // --- data sources -------------------------------------------------------------------------
      if (target.kind === "aircraft") {
        const feed = (s: ReturnType<typeof useAircraftStore.getState>) => {
          const ac = s.byHex[target.id];
          if (!ac) return;
          nameRef.current = ac.flight?.trim() || target.id.toUpperCase();
          const sample = aircraftSample(ac, s.lastSnapshotAt || Date.now());
          if (sample) tracker.update(sample, Date.now());
        };
        feed(useAircraftStore.getState());
        cleanups.push(useAircraftStore.subscribe(feed));
      } else if (target.kind === "vessel") {
        const feed = (s: ReturnType<typeof useVesselStore.getState>) => {
          const v = s.byMmsi[target.id];
          if (!v) return;
          nameRef.current = v.name?.trim() || `MMSI ${target.id}`;
          const sample = vesselSample(v, s.lastSnapshotAt || Date.now());
          if (sample) tracker.update(sample, Date.now());
        };
        feed(useVesselStore.getState());
        cleanups.push(useVesselStore.subscribe(feed));
      } else {
        const noradId = Number(target.id);
        nameRef.current = `NORAD ${target.id}`;
        new ApiClient({ baseUrl: getApiBaseUrl() })
          .satelliteDetail(noradId)
          .then((detail) => {
            if (cancelled) return;
            satrec = buildSatrec(detail.satellite.omm);
            nameRef.current = detail.satellite.name?.trim() || nameRef.current;
            if (!satrec) setError("This satellite's orbit can't be propagated.");
          })
          .catch(() => {
            if (!cancelled) setError("Couldn't load the satellite's orbit.");
          });
      }

      // --- HUD + subscription centre at 4 Hz -----------------------------------------------------
      const hudTimer = setInterval(() => {
        const now = Date.now();
        if (satrec) {
          const s = satelliteStateAt(satrec, new Date(now));
          if (s) tracker.update(satelliteSample(s, now), now);
        }
        // Without Cesium (still loading, or failed) the pose is computed here; with it, the render
        // loop has already advanced the tracker this frame.
        const pose = widget ? lastPose : tracker.pose(now);
        if (pose) setPosition(pose.lat, pose.lon);
        setHud({ pose, name: nameRef.current });
      }, HUD_MS);
      cleanups.push(() => clearInterval(hudTimer));

      // --- Cesium -------------------------------------------------------------------------------
      loadCesium()
        .then((C) => {
          if (cancelled) return;
          widget = new C.CesiumWidget(el, {
            baseLayer: C.ImageryLayer.fromProviderAsync(C.ArcGisMapServerImageryProvider.fromUrl(ESRI_IMAGERY_URL)),
            terrain: new C.Terrain(C.ArcGISTiledElevationTerrainProvider.fromUrl(ESRI_TERRAIN_URL)),
            scene3DOnly: true,
          });
          const scene = widget.scene;
          scene.screenSpaceCameraController.enableInputs = false; // the camera is ours
          scene.globe.depthTestAgainstTerrain = true;
          setEngineReady(true);

          const onPreRender = () => {
            const now = Date.now();
            if (satrec) {
              const s = satelliteStateAt(satrec, new Date(now));
              if (s) tracker.update(satelliteSample(s, now), now);
            }
            const prev = lastPose;
            const terrain = prev
              ? scene.globe.getHeight(C.Cartographic.fromDegrees(prev.lon, prev.lat))
              : undefined;
            const pose = tracker.pose(now, terrain);
            if (!pose) return;
            lastPose = pose;
            const look = lookRef.current;
            widget?.camera.setView({
              destination: C.Cartesian3.fromDegrees(pose.lon, pose.lat, pose.altM),
              orientation: {
                heading: C.Math.toRadians(pose.headingDeg + look.yaw),
                pitch: C.Math.toRadians(
                  Math.max(-89, Math.min(89, pose.pitchDeg + look.pitch)),
                ),
                roll: 0,
              },
            });
          };
          cleanups.push(scene.preRender.addEventListener(onPreRender));
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't start the 3D view.");
        });

      // --- drag to look around ------------------------------------------------------------------
      let drag: { x: number; y: number } | null = null;
      const onDown = (e: PointerEvent) => {
        drag = { x: e.clientX, y: e.clientY };
        el.setPointerCapture(e.pointerId);
      };
      const onMove = (e: PointerEvent) => {
        if (!drag) return;
        const look = lookRef.current;
        look.yaw -= (e.clientX - drag.x) * LOOK_DEG_PER_PX;
        look.pitch = Math.max(
          -MAX_LOOK_PITCH_DEG,
          Math.min(MAX_LOOK_PITCH_DEG, look.pitch + (e.clientY - drag.y) * LOOK_DEG_PER_PX),
        );
        drag = { x: e.clientX, y: e.clientY };
      };
      const onUp = () => {
        drag = null;
      };
      const onReset = () => {
        lookRef.current = { yaw: 0, pitch: 0 };
      };
      el.addEventListener("pointerdown", onDown);
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
      el.addEventListener("dblclick", onReset);
      cleanups.push(() => {
        el.removeEventListener("pointerdown", onDown);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
        el.removeEventListener("dblclick", onReset);
      });

      return () => {
        cancelled = true;
        for (const fn of cleanups) fn();
        if (widget && !widget.isDestroyed()) widget.destroy();
        widget = null;
        setEngineReady(false);
        setError(null);
        setHud({ pose: null, name: "" });
        stop();
      };
    }, [target, start, stop, setPosition]),
  );

  if (!target) {
    return (
      <View style={styles.center}>
        <Text style={styles.message}>Nothing to follow. Open an aircraft, vessel or satellite first.</Text>
        <Pressable testID="sim-exit" style={styles.exit} onPress={exit}>
          <Text style={styles.exitText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  const pose = hud.pose;
  return (
    <View style={styles.root} testID="sim-screen">
      <div
        ref={containerRef}
        data-testid="sim-view"
        style={{ position: "absolute", inset: 0, touchAction: "none", cursor: "grab" }}
      />

      <View style={styles.hud} pointerEvents="box-none" testID="sim-hud">
        <Text testID="sim-name" style={styles.name}>
          {hud.name || "…"}
        </Text>
        {pose ? <HudRows kind={target.kind} pose={pose} /> : null}
        <Text testID="sim-status" style={[styles.status, pose?.stale && styles.lost]}>
          {statusText(pose, engineReady, error)}
        </Text>
      </View>

      <Pressable testID="sim-exit" style={[styles.exit, styles.exitFloating]} onPress={exit}>
        <Text style={styles.exitText}>Exit</Text>
      </Pressable>
    </View>
  );
}

function statusText(pose: TrackedPose | null, engineReady: boolean, error: string | null): string {
  if (error) return error;
  if (!pose) return "Waiting for position…";
  if (pose.stale) return "Signal lost — holding last position";
  if (!engineReady) return "Loading 3D view…";
  return pose.ageS < 3 ? "Live" : `Data ${Math.round(pose.ageS)} s old`;
}

function HudRows({ kind, pose }: { kind: SimKind; pose: TrackedPose }) {
  const heading = `${Math.round(pose.headingDeg) % 360}°`;
  const knots = `${Math.round(pose.speedMps / KNOTS_TO_MPS)} kt`;
  const rows: [string, string, string][] =
    kind === "satellite"
      ? [
          ["ALT", `${Math.round(pose.altM / 1000)} km`, "sim-alt"],
          ["SPD", `${(pose.speedMps / 1000).toFixed(2)} km/s`, "sim-speed"],
          ["HDG", heading, "sim-heading"],
        ]
      : kind === "vessel"
        ? [
            ["SPD", knots, "sim-speed"],
            ["HDG", heading, "sim-heading"],
          ]
        : [
            ["ALT", `${Math.round(pose.altM / FEET_TO_M / 10) * 10} ft`, "sim-alt"],
            ["SPD", knots, "sim-speed"],
            ["HDG", heading, "sim-heading"],
            ["PITCH", `${pose.pitchDeg.toFixed(1)}°`, "sim-pitch"],
          ];
  return (
    <View style={styles.rows}>
      {rows.map(([label, value, testID]) => (
        <View key={label} style={styles.row}>
          <Text style={styles.label}>{label}</Text>
          <Text testID={testID} style={styles.value}>
            {value}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  center: {
    flex: 1,
    backgroundColor: color.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 16,
  },
  message: { color: color.textDim, fontSize: 15, textAlign: "center" },
  hud: {
    position: "absolute",
    top: 16,
    left: 16,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "rgba(11, 22, 34, 0.72)",
    minWidth: 180,
  },
  name: { color: color.text, fontSize: 18, fontWeight: "700", marginBottom: 6 },
  rows: { gap: 2 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 16 },
  label: { color: color.textMuted, fontSize: 13, fontWeight: "600" },
  value: { color: color.text, fontSize: 14, fontVariant: ["tabular-nums"] },
  status: { color: color.textDim, fontSize: 12, marginTop: 8 },
  lost: { color: "#FFB45C" },
  exit: {
    backgroundColor: color.accentFill,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  exitFloating: { position: "absolute", top: 16, right: 16 },
  exitText: { color: color.text, fontSize: 15, fontWeight: "600" },
});
