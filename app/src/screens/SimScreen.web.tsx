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
 *
 * Looking around: dragging adds a look offset to the direction of travel; on a phone, "Pan/tilt" uses
 * the device's own orientation instead (the AR view's DeviceOrientation sensors), relative to the pose
 * it had when switched on. A flight-path-style marker shows where straight ahead is (clamped to the edge
 * with an arrow when out of view), and "Recenter" (or a double click) snaps back to it. Math: src/sim/look.ts.
 *
 * Map aids: a minimap inset (SimMinimap) keeps the object centred with a heading arrow; tapping it opens
 * the full Map on the target. Nearby airports (GET /api/airports) and ports (GET /api/ports), refetched as
 * the object moves, are labelled in the 3D scene, each class from its own distance (src/sim/overlay.ts).
 */

import { color } from "@/theme";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { SatRec } from "satellite.js";
import type { Cartesian3, CesiumWidget, LabelCollection, PointPrimitiveCollection } from "cesium";
import { SimMinimap } from "@/components/SimMinimap";
import { useWebArSensors } from "@/components/useWebArSensors";
import { AIRPORT_COLOR, airportShortLabel } from "@/components/webmap/airportStyle";
import { PORT_COLOR, portTitle } from "@/components/webmap/portStyle";
import {
  describeLook,
  forwardMarker,
  isCentred,
  lookFromDevice,
  MAX_LOOK_PITCH_DEG,
  wrap180,
  type Look,
} from "@/sim/look";
import { useMapFocusStore } from "@/state/mapFocusStore";
import { useSatelliteTrackStore } from "@/state/satelliteTrackStore";
import {
  AIRPORT_FETCH_RADIUS_KM,
  AIRPORT_REFETCH_KM,
  airportLabelRangeM,
  distanceKm,
  minimapZoom,
  PORT_FETCH_RADIUS_KM,
  PORT_REFETCH_KM,
  portLabelRangeM,
  showsAirportOverlay,
  showsPortOverlay,
} from "@/sim/overlay";
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
/** How far ahead along the direction of travel the "straight ahead" marker is projected, metres. */
const FORWARD_PROBE_M = 20_000;

/** One labelled point in the 3D scene (airport or port). */
interface OverlayItem {
  lat: number;
  lon: number;
  altM: number;
  /** Empty → point only. */
  label: string;
  rangeM: number;
  pixelSize: number;
}

/** A phone/tablet browser with orientation sensors: the "Pan/tilt" look mode is offered there. */
function deviceLookSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "DeviceOrientationEvent" in window &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

/** Flight-path-vector style symbol: a ring with wings and a fin, like a HUD's velocity marker. */
const FPV_SVG =
  '<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="#7CFC9A" stroke-width="2" ' +
  'style="filter:drop-shadow(0 0 2px #000)"><circle cx="14" cy="14" r="5"/>' +
  '<path d="M2 14h7M19 14h7M14 9V3"/></svg>';

/** Edge arrow pointing towards straight ahead, `deg` clockwise from up. */
function arrowSvg(deg: number): string {
  return (
    `<svg width="28" height="28" viewBox="0 0 28 28" style="transform:rotate(${deg}deg);filter:drop-shadow(0 0 2px #000)">` +
    '<path d="M14 2 L24 22 L14 17 L4 22 Z" fill="#7CFC9A" stroke="#0B1622" stroke-width="1.5"/></svg>'
  );
}

const KINDS: readonly SimKind[] = ["aircraft", "vessel", "satellite"];

function parseTarget(kind: unknown, id: unknown): SimTarget | null {
  if (typeof kind !== "string" || typeof id !== "string" || !id) return null;
  return (KINDS as readonly string[]).includes(kind) ? { kind: kind as SimKind, id } : null;
}

interface Hud {
  pose: TrackedPose | null;
  name: string;
  look: Look;
}

const LEVEL: Readonly<Look> = Object.freeze({ yaw: 0, pitch: 0 });

export default function SimScreen() {
  const params = useLocalSearchParams<{ kind?: string; id?: string }>();
  const target = useMemo(() => parseTarget(params.kind, params.id), [params.kind, params.id]);
  const router = useRouter();
  const start = useSimStore((s) => s.start);
  const stop = useSimStore((s) => s.stop);
  const setPosition = useSimStore((s) => s.setPosition);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const lookRef = useRef<Look>(LEVEL);
  const markerRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef("");
  const [hud, setHud] = useState<Hud>({ pose: null, name: "", look: LEVEL });

  // Look mode: drag (default) or the device's own pan/tilt. The sensor hook runs only in device mode.
  const [deviceLook, setDeviceLook] = useState(false);
  const [canDeviceLook] = useState(() => deviceLookSupported());
  const {
    status: sensorStatus,
    poseRef: sensorPoseRef,
    request: requestSensors,
    stop: stopSensors,
  } = useWebArSensors({ enabled: deviceLook, trimDeg: 0 });
  // Read by the render loop and the pointer handlers, which live outside React's render.
  const deviceActiveRef = useRef(false);
  const deviceActive = deviceLook && sensorStatus === "active";
  useEffect(() => {
    deviceActiveRef.current = deviceActive;
  }, [deviceActive]);
  /** Device pose that counts as "straight ahead"; null → the next sample becomes it. */
  const deviceRefRef = useRef<{ azimuth: number; elevation: number } | null>(null);

  const recenter = useCallback(() => {
    lookRef.current = LEVEL;
    deviceRefRef.current = null; // pan/tilt: wherever the phone points now becomes straight ahead
  }, []);

  const toggleDeviceLook = useCallback(() => {
    if (deviceLook) {
      setDeviceLook(false);
      stopSensors();
      recenter();
      return;
    }
    deviceRefRef.current = null;
    setDeviceLook(true);
    // iOS asks for the sensor permission here, inside the tap (Android has no gate).
    if (sensorStatus === "needs-permission") void requestSensors();
  }, [deviceLook, sensorStatus, requestSensors, stopSensors, recenter]);
  const [error, setError] = useState<string | null>(null);
  const [engineReady, setEngineReady] = useState(false);

  const exit = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [router]);

  // Minimap tap: hand the target to the full Map (aircraft/vessel follow, satellite ground track).
  const setMapFocus = useMapFocusStore((s) => s.setFocus);
  const setTrackedSatellite = useSatelliteTrackStore((s) => s.setTracked);
  const openOnMap = useCallback(() => {
    if (!target) return;
    if (target.kind === "aircraft") setMapFocus({ kind: "aircraft", hex: target.id });
    else if (target.kind === "vessel") setMapFocus({ kind: "vessel", mmsi: target.id });
    else setTrackedSatellite(Number(target.id));
    router.push("/map");
  }, [target, setMapFocus, setTrackedSatellite, router]);

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
        setHud({ pose, name: nameRef.current, look: lookRef.current });
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
            if (deviceActiveRef.current) {
              const device = sensorPoseRef.current;
              deviceRefRef.current ??= { azimuth: device.azimuth, elevation: device.elevation };
              lookRef.current = lookFromDevice(device, deviceRefRef.current);
            }
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
            placeForwardMarker(pose, look);
          };

          // "Straight ahead" marker: project a point FORWARD_PROBE_M along the direction of travel and
          // draw it straight into the DOM every frame (no React state at 60 fps).
          const enu = new C.Matrix4();
          const probeLocal = new C.Cartesian3();
          const probe = new C.Cartesian3();
          const toProbe = new C.Cartesian3();
          let markerState = "";
          const placeForwardMarker = (pose: TrackedPose, look: Look) => {
            const marker = markerRef.current;
            const cam = widget?.camera;
            if (!marker || !cam) return;
            const origin: Cartesian3 = C.Cartesian3.fromDegrees(pose.lon, pose.lat, pose.altM);
            C.Transforms.eastNorthUpToFixedFrame(origin, undefined, enu);
            const h = C.Math.toRadians(pose.headingDeg);
            const p = C.Math.toRadians(pose.pitchDeg);
            probeLocal.x = Math.sin(h) * Math.cos(p) * FORWARD_PROBE_M;
            probeLocal.y = Math.cos(h) * Math.cos(p) * FORWARD_PROBE_M;
            probeLocal.z = Math.sin(p) * FORWARD_PROBE_M;
            C.Matrix4.multiplyByPoint(enu, probeLocal, probe);
            C.Cartesian3.normalize(C.Cartesian3.subtract(probe, cam.positionWC, toProbe), toProbe);
            // Only trust the projection in front of the camera; behind it, fall back to the look offset.
            const inFront = C.Cartesian3.dot(toProbe, cam.directionWC) > 0.05;
            const win = inFront ? C.SceneTransforms.worldToWindowCoordinates(scene, probe) : undefined;
            const m = forwardMarker(
              look,
              win ? { x: win.x, y: win.y } : null,
              scene.canvas.clientWidth,
              scene.canvas.clientHeight,
            );
            marker.style.transform = `translate(${m.x}px, ${m.y}px)`;
            const state = m.onScreen ? "on" : `off:${Math.round(m.angleDeg)}`;
            if (state !== markerState) {
              markerState = state;
              marker.dataset.onscreen = String(m.onScreen);
              marker.innerHTML = m.onScreen ? FPV_SVG : arrowSvg(m.angleDeg);
            }
          };
          cleanups.push(scene.preRender.addEventListener(onPreRender));

          // --- airports + ports: labelled points, each class visible from its own distance -----------
          const client = new ApiClient({ baseUrl: getApiBaseUrl() });
          /**
           * One labelled-point layer that refetches once the object has moved `refetchKm` from the last
           * fetch centre. Fail soft: a failed fetch draws nothing and the next tick retries.
           */
          const addOverlay = (
            cssColor: string,
            refetchKm: number,
            load: (lat: number, lon: number) => Promise<OverlayItem[]>,
          ) => {
            const labels: LabelCollection = scene.primitives.add(new C.LabelCollection());
            const points: PointPrimitiveCollection = scene.primitives.add(new C.PointPrimitiveCollection());
            const pointColor = C.Color.fromCssColorString(cssColor);
            const draw = (items: OverlayItem[]) => {
              labels.removeAll();
              points.removeAll();
              for (const it of items) {
                const position = C.Cartesian3.fromDegrees(it.lon, it.lat, it.altM);
                const shown = new C.DistanceDisplayCondition(0, it.rangeM);
                points.add({
                  position,
                  pixelSize: it.pixelSize,
                  color: pointColor,
                  outlineColor: C.Color.BLACK,
                  outlineWidth: 1,
                  distanceDisplayCondition: shown,
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                });
                if (!it.label) continue;
                labels.add({
                  position,
                  text: it.label,
                  font: "600 13px sans-serif",
                  fillColor: C.Color.WHITE,
                  outlineColor: C.Color.BLACK,
                  outlineWidth: 3,
                  style: C.LabelStyle.FILL_AND_OUTLINE,
                  pixelOffset: new C.Cartesian2(0, -14),
                  distanceDisplayCondition: shown,
                  // Like synthetic vision: labels stay readable even behind a ridge.
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                });
              }
            };
            let fetchedAt: { lat: number; lon: number } | null = null;
            let inFlight = false;
            const maybeFetch = () => {
              const pose = lastPose;
              if (!pose || inFlight || cancelled) return;
              if (fetchedAt && distanceKm(fetchedAt.lat, fetchedAt.lon, pose.lat, pose.lon) < refetchKm) return;
              inFlight = true;
              const at = { lat: pose.lat, lon: pose.lon };
              load(Math.round(at.lat * 100) / 100, Math.round(at.lon * 100) / 100)
                .then((items) => {
                  if (cancelled || labels.isDestroyed()) return;
                  fetchedAt = at;
                  draw(items);
                })
                .catch(() => {
                  // Fail soft: nothing drawn this time; the next tick retries.
                })
                .finally(() => {
                  inFlight = false;
                });
            };
            const timer = setInterval(maybeFetch, 2000);
            cleanups.push(() => clearInterval(timer));
          };

          if (showsAirportOverlay(target.kind)) {
            addOverlay(AIRPORT_COLOR, AIRPORT_REFETCH_KM, async (lat, lon) => {
              const res = await client.airports(lat, lon, AIRPORT_FETCH_RADIUS_KM);
              const items: OverlayItem[] = [];
              for (const a of res.airports ?? []) {
                const rangeM = airportLabelRangeM(a.type);
                if (rangeM == null) continue;
                items.push({
                  lat: a.lat,
                  lon: a.lon,
                  // Field elevation + a little, so the marker sits on the runway, not under the terrain.
                  altM: (a.elevationFt ?? 0) * FEET_TO_M + 20,
                  label: airportShortLabel(a),
                  rangeM,
                  pixelSize: a.type === "large_airport" ? 9 : 6,
                });
              }
              return items;
            });
          }
          if (showsPortOverlay(target.kind)) {
            addOverlay(PORT_COLOR, PORT_REFETCH_KM, async (lat, lon) => {
              const res = await client.ports(lat, lon, PORT_FETCH_RADIUS_KM);
              return (res.ports ?? []).map((p) => ({
                lat: p.lat,
                lon: p.lon,
                altM: 8, // quay level
                // Unnamed quays and marinas get a dot only ("Marina" forty times along a fjord is noise);
                // an unnamed commercial port is still a landmark, so it keeps its kind as the label.
                label: p.name?.trim() || (p.kind === "port" ? portTitle(p) : ""),
                rangeM: portLabelRangeM(p.kind),
                pixelSize: p.kind === "port" ? 8 : 5,
              }));
            });
          }
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
        if (!drag || deviceActiveRef.current) return; // pan/tilt mode: the phone aims the view
        // A new object every time: mutating in place would also change LEVEL, which recenter() and the
        // initial state share, so "Recenter" would snap back to the dragged offset.
        const look = lookRef.current;
        lookRef.current = {
          yaw: wrap180(look.yaw - (e.clientX - drag.x) * LOOK_DEG_PER_PX),
          pitch: Math.max(
            -MAX_LOOK_PITCH_DEG,
            Math.min(MAX_LOOK_PITCH_DEG, look.pitch + (e.clientY - drag.y) * LOOK_DEG_PER_PX),
          ),
        };
        drag = { x: e.clientX, y: e.clientY };
      };
      const onUp = () => {
        drag = null;
      };
      const onReset = () => recenter();
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
        setHud({ pose: null, name: "", look: LEVEL });
        stop();
      };
    }, [target, start, stop, setPosition, recenter, sensorPoseRef]),
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
      {/* "Straight ahead" marker, positioned every frame by the render loop (placeForwardMarker). */}
      <div
        ref={markerRef}
        data-testid="sim-forward"
        style={{
          position: "absolute",
          left: -14,
          top: -14,
          width: 28,
          height: 28,
          pointerEvents: "none",
          display: engineReady ? "block" : "none",
        }}
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

      {pose ? (
        <SimMinimap
          lat={pose.lat}
          lon={pose.lon}
          headingDeg={pose.headingDeg}
          zoom={minimapZoom(target.kind, pose.altM)}
          accent={
            target.kind === "aircraft"
              ? color.entity.air
              : target.kind === "vessel"
                ? color.entity.sea
                : color.entity.orbit
          }
          onPress={openOnMap}
        />
      ) : null}

      <View style={styles.topRight} pointerEvents="box-none">
        <Pressable testID="sim-exit" style={styles.exit} onPress={exit}>
          <Text style={styles.exitText}>Exit</Text>
        </Pressable>
        {canDeviceLook ? (
          <Pressable
            testID="sim-look-device"
            accessibilityState={{ selected: deviceLook }}
            style={[styles.chip, deviceLook && styles.chipOn]}
            onPress={toggleDeviceLook}
          >
            <Text style={[styles.chipText, deviceLook && styles.chipTextOn]}>
              {deviceLook ? (sensorStatus === "denied" ? "Pan/tilt denied" : "Pan/tilt on") : "Pan/tilt"}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {!isCentred(hud.look) ? (
        <Pressable testID="sim-recenter" style={styles.recenter} onPress={recenter}>
          <Text style={styles.recenterText}>↺ Recenter</Text>
          <Text testID="sim-look-offset" style={styles.recenterOffset}>
            {describeLook(hud.look)}
          </Text>
        </Pressable>
      ) : null}
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
  topRight: { position: "absolute", top: 16, right: 16, alignItems: "flex-end", gap: 8 },
  chip: {
    backgroundColor: "rgba(11, 22, 34, 0.72)",
    borderColor: color.textMuted,
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  chipOn: { borderColor: color.status.ok },
  chipText: { color: color.textDim, fontSize: 13, fontWeight: "600" },
  chipTextOn: { color: color.status.ok },
  recenter: {
    position: "absolute",
    top: 16,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(11, 22, 34, 0.8)",
    borderColor: color.status.ok,
    borderWidth: 1,
    borderRadius: 18,
    paddingVertical: 7,
    paddingHorizontal: 14,
  },
  recenterText: { color: color.status.ok, fontSize: 14, fontWeight: "700" },
  recenterOffset: { color: color.textDim, fontSize: 13, fontVariant: ["tabular-nums"] },
  exitText: { color: color.text, fontSize: 15, fontWeight: "600" },
});
