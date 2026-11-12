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
 *
 * The Cesium scene itself (camera, forward marker, label layers, drag-to-look) is src/sim/simGlobe.ts and
 * the HUD box is components/SimHud.tsx, both shared with the Android screen (SimScreen.tsx).
 */

import { color } from "@/theme";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { SatRec } from "satellite.js";
import { SimHud } from "@/components/SimHud";
import { SimMinimap } from "@/components/SimMinimap";
import { useWebArSensors } from "@/components/useWebArSensors";
import { AIRPORT_COLOR } from "@/components/webmap/airportStyle";
import { PORT_COLOR } from "@/components/webmap/portStyle";
import { describeLook, isCentred, lookFromDevice, type Look } from "@/sim/look";
import { useMapFocusStore } from "@/state/mapFocusStore";
import { useSatelliteTrackStore } from "@/state/satelliteTrackStore";
import {
  AIRPORT_REFETCH_KM,
  minimapZoom,
  PORT_REFETCH_KM,
  showsAirportOverlay,
  showsPortOverlay,
} from "@/sim/overlay";
import { fetchOverlayItems } from "@/sim/overlayData";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl } from "@/api/config";
import { buildSatrec, satelliteStateAt } from "@/ar/satellites";
import { orbitInfo, type OrbitClass } from "@/ar/orbitClass";
import { useAircraftStore } from "@/state/aircraftStore";
import { isApiAllowed } from "@/state/authStore";
import { useVesselStore } from "@/state/vesselStore";
import { useSimStore } from "@/state/simStore";
import { loadCesium } from "@/sim/loadCesium";
import { statusText } from "@/sim/hud";
import { attachLookGestures, createSimGlobe, type SimGlobe, type SimOverlayLayer } from "@/sim/simGlobe";
import { aircraftSample, satelliteSample, vesselSample } from "@/sim/simPose";
import { parseTarget } from "@/sim/target";
import { SimTracker, type TrackedPose } from "@/sim/tracker";

/** HUD refresh rate; the camera itself updates every frame. */
const HUD_MS = 250;

/** A phone/tablet browser with orientation sensors: the "Pan/tilt" look mode is offered there. */
function deviceLookSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "DeviceOrientationEvent" in window &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
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
  // The followed satellite's orbit class, from the OMM the session already fetches; null otherwise.
  const [orbitClass, setOrbitClass] = useState<OrbitClass | null>(null);

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
      let globe: SimGlobe | null = null;
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
        if (!isApiAllowed()) {
          // Signed out behind real auth: no API calls, so the orbit can't be loaded.
          setError("Sign in to load the satellite's orbit.");
        } else {
          new ApiClient({ baseUrl: getApiBaseUrl() })
            .satelliteDetail(noradId)
            .then((detail) => {
              if (cancelled) return;
              satrec = buildSatrec(detail.satellite.omm);
              setOrbitClass(orbitInfo(detail.satellite.omm)?.class ?? null);
              nameRef.current = detail.satellite.name?.trim() || nameRef.current;
              if (!satrec) setError("This satellite's orbit can't be propagated.");
            })
            .catch(() => {
              if (!cancelled) setError("Couldn't load the satellite's orbit.");
            });
        }
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
        const pose = globe ? lastPose : tracker.pose(now);
        if (pose) setPosition(pose.lat, pose.lon);
        setHud({ pose, name: nameRef.current, look: lookRef.current });
      }, HUD_MS);
      cleanups.push(() => clearInterval(hudTimer));

      // --- Cesium (shared with the Android globe: src/sim/simGlobe.ts) ---------------------------
      loadCesium()
        .then((C) => {
          if (cancelled) return;
          const client = new ApiClient({ baseUrl: getApiBaseUrl() });
          const overlays: SimOverlayLayer[] = [];
          // No API calls without access (signed out behind real auth): no labels, no fetch.
          if (showsAirportOverlay(target.kind)) {
            overlays.push({
              color: AIRPORT_COLOR,
              refetchKm: AIRPORT_REFETCH_KM,
              load: (lat, lon) => fetchOverlayItems(client, "airports", lat, lon),
              allowed: isApiAllowed,
            });
          }
          if (showsPortOverlay(target.kind)) {
            overlays.push({
              color: PORT_COLOR,
              refetchKm: PORT_REFETCH_KM,
              load: (lat, lon) => fetchOverlayItems(client, "ports", lat, lon),
              allowed: isApiAllowed,
            });
          }
          let lookReferenced = false;
          globe = createSimGlobe(C, {
            container: el,
            marker: () => markerRef.current,
            pose: (now, terrain) => {
              if (satrec) {
                const s = satelliteStateAt(satrec, new Date(now));
                if (s) tracker.update(satelliteSample(s, now), now);
              }
              const pose = tracker.pose(now, terrain);
              if (pose) lastPose = pose;
              return pose;
            },
            look: () => {
              if (deviceActiveRef.current) {
                const device = sensorPoseRef.current;
                deviceRefRef.current ??= { azimuth: device.azimuth, elevation: device.elevation };
                lookRef.current = lookFromDevice(device, deviceRefRef.current);
              }
              // Expose whether pan/tilt has captured its "straight ahead" pose (e2e waits on it).
              const referenced = deviceRefRef.current != null;
              if (referenced !== lookReferenced) {
                lookReferenced = referenced;
                el.dataset.lookReference = String(referenced);
              }
              return lookRef.current;
            },
            overlays,
          });
          setEngineReady(true);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't start the 3D view.");
        });

      // --- drag to look around (pan/tilt mode: the phone aims the view) ---------------------------
      cleanups.push(
        attachLookGestures(el, {
          get: () => lookRef.current,
          set: (look) => {
            lookRef.current = look;
          },
          enabled: () => !deviceActiveRef.current,
          onReset: recenter,
        }),
      );

      return () => {
        cancelled = true;
        for (const fn of cleanups) fn();
        globe?.destroy();
        globe = null;
        setEngineReady(false);
        setError(null);
        setOrbitClass(null);
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
      {/* "Straight ahead" marker, positioned every frame by the render loop (src/sim/simGlobe.ts). */}
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

      <SimHud
        kind={target.kind}
        name={hud.name}
        pose={pose}
        orbitClass={orbitClass}
        status={statusText(pose, engineReady, error)}
      />

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
            // An on/off toggle: `aria-pressed` (react-native-web drops accessibilityState) so the
            // state reaches assistive tech and the DOM.
            role="button"
            aria-pressed={deviceLook}
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
