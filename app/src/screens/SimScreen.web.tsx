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
 * The session (target, tracker, data subscriptions) and the globe are separate effects, so "Follow this"
 * re-targets the session without tearing down the globe (it is only rebuilt between surface and orbit).
 *
 * Looking around: dragging adds a look offset to the direction of travel; on a phone, "Pan/tilt" uses
 * the device's own orientation instead (the AR view's DeviceOrientation sensors), relative to the pose
 * it had when switched on. A flight-path-style marker shows where straight ahead is (clamped to the edge
 * with an arrow when out of view), and "Recenter" (or a double click / double tap) snaps back to it.
 * "Outside view" (sim-camera-toggle) moves the camera behind and above the object (src/sim/chase.ts);
 * look-around orbits it there. Math: src/sim/look.ts, src/sim/chase.ts.
 *
 * Map aids: a minimap inset (SimMinimap) keeps the object centred with a heading arrow; tapping it opens
 * the full Map on the target. Nearby airports (GET /api/airports) and ports (GET /api/ports, ferry quays
 * styled apart), refetched as the object moves, are labelled in the 3D scene, each class from its own
 * distance (src/sim/overlay.ts); the HUD shows the nearest one and, when the route is known, the
 * destination with a route line. Other aircraft/vessels nearby are drawn from the live stores
 * (src/sim/traffic.ts); a tap on one opens its card with "Follow this". A "Layers" filter hides layers.
 *
 * The Cesium scene itself is src/sim/simGlobe.ts, the HUD box components/SimHud.tsx, the card
 * components/SimCard.tsx and the extras' state components/useSimCockpit.ts, all shared with the Android
 * screen (SimScreen.tsx).
 */

import { color } from "@/theme";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { SatRec } from "satellite.js";
import { SheetHeightContext } from "@/components/Sheet";
import { SimCard } from "@/components/SimCard";
import { SimActionChip, SimFilter, SimToggleChip } from "@/components/SimControls";
import { SimHud } from "@/components/SimHud";
import { SimMinimap } from "@/components/SimMinimap";
import { useSimCockpit } from "@/components/useSimCockpit";
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
import { fetchOverlay } from "@/sim/overlayData";
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
import { cockpitLayout, hudMaxWidth } from "@/sim/layout";
import { attachLookGestures, createSimGlobe, type SimGlobe, type SimOverlayLayer } from "@/sim/simGlobe";
import { aircraftSample, satelliteSample, vesselSample, type SimKind } from "@/sim/simPose";
import { parseTarget } from "@/sim/target";
import { SimTracker, type TrackedPose } from "@/sim/tracker";

/** HUD refresh rate; the camera itself updates every frame. */
const HUD_MS = 250;
/** The HUD's left and the control column's right margin (SimHud's own top/left offset), px. */
const HUD_EDGE = 16;

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
  const win = useWindowDimensions();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const lookRef = useRef<Look>(LEVEL);
  const markerRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef("");
  // The session's state, read by the globe's render loop (which outlives a re-target).
  const trackerRef = useRef(new SimTracker());
  const satrecRef = useRef<SatRec | null>(null);
  const kindRef = useRef<SimKind>(target?.kind ?? "aircraft");
  const globeRef = useRef<SimGlobe | null>(null);
  const [hud, setHud] = useState<Hud>({ pose: null, name: "", look: LEVEL });
  const [focused, setFocused] = useState(false);

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

  // Card, filter, camera mode, traffic and nav aids (shared with the Android screen).
  const cockpit = useSimCockpit({
    target,
    focused,
    onTraffic: (items) => globeRef.current?.setTraffic(items),
  });
  const { select, poseRef, onPlaces } = cockpit;
  // Read by the tap handler, which lives as long as the globe (a re-target must not rebuild it).
  const selectRef = useRef(select);
  useEffect(() => {
    selectRef.current = select;
  }, [select]);
  useEffect(() => {
    globeRef.current?.setVisibility(cockpit.visibility);
  }, [cockpit.visibility, engineReady]);
  useEffect(() => {
    globeRef.current?.setCameraMode(cockpit.cameraMode);
  }, [cockpit.cameraMode, engineReady]);
  useEffect(() => {
    globeRef.current?.setDestination(cockpit.destination);
  }, [cockpit.destination, engineReady]);

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

  // --- the session: target, tracker, data subscriptions (re-run on "Follow this") ------------------
  useFocusEffect(
    useCallback(() => {
      if (!target) return;
      // (Re)start the session: also covers a reload or deep link straight to /sim.
      start(target);
      kindRef.current = target.kind;
      const tracker = new SimTracker();
      trackerRef.current = tracker;
      satrecRef.current = null;
      lookRef.current = LEVEL;
      deviceRefRef.current = null;
      globeRef.current?.clearTraffic();
      let cancelled = false;
      const cleanups: (() => void)[] = [];

      if (target.kind === "aircraft") {
        const feed = (s: ReturnType<typeof useAircraftStore.getState>) => {
          const ac = s.byHex[target.id];
          if (!ac) return;
          nameRef.current = ac.flight?.trim() || target.id.toUpperCase();
          const sample = aircraftSample(ac, s.lastSnapshotAt || Date.now());
          if (sample) tracker.update(sample, Date.now());
        };
        nameRef.current = target.id.toUpperCase();
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
        nameRef.current = `MMSI ${target.id}`;
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
              satrecRef.current = buildSatrec(detail.satellite.omm);
              setOrbitClass(orbitInfo(detail.satellite.omm)?.class ?? null);
              nameRef.current = detail.satellite.name?.trim() || nameRef.current;
              if (!satrecRef.current) setError("This satellite's orbit can't be propagated.");
            })
            .catch(() => {
              if (!cancelled) setError("Couldn't load the satellite's orbit.");
            });
        }
      }
      // Centre the subscription on the new target straight away: a re-target must not fall back to
      // the observer for a tick, or the object could drop out of the feed.
      const first = tracker.pose(Date.now());
      if (first) setPosition(first.lat, first.lon);

      return () => {
        cancelled = true;
        for (const fn of cleanups) fn();
        setError(null);
        setOrbitClass(null);
        stop();
      };
    }, [target, start, stop, setPosition]),
  );

  // --- the globe, HUD and gestures: tied to focus, rebuilt only between surface and orbit -----------
  const surface = target ? target.kind !== "satellite" : null;
  useFocusEffect(
    useCallback(() => {
      if (surface == null) return;
      const el = containerRef.current;
      if (!el) return;
      setFocused(true);
      let cancelled = false;
      let globe: SimGlobe | null = null;
      const cleanups: (() => void)[] = [];
      let lastPose: TrackedPose | null = null;

      // --- HUD + subscription centre at 4 Hz -----------------------------------------------------
      const hudTimer = setInterval(() => {
        const now = Date.now();
        const satrec = satrecRef.current;
        if (satrec) {
          const s = satelliteStateAt(satrec, new Date(now));
          if (s) trackerRef.current.update(satelliteSample(s, now), now);
        }
        // Without Cesium (still loading, or failed) the pose is computed here; with it, the render
        // loop has already advanced the tracker this frame.
        const pose = globe ? lastPose : trackerRef.current.pose(now);
        if (pose) setPosition(pose.lat, pose.lon);
        poseRef.current = pose;
        setHud({ pose, name: nameRef.current, look: lookRef.current });
      }, HUD_MS);
      cleanups.push(() => clearInterval(hudTimer));

      // --- Cesium (shared with the Android globe: src/sim/simGlobe.ts) ---------------------------
      loadCesium()
        .then((C) => {
          if (cancelled) return;
          const client = new ApiClient({ baseUrl: getApiBaseUrl() });
          const kind = kindRef.current;
          const overlays: SimOverlayLayer[] = [];
          // No API calls without access (signed out behind real auth): no labels, no fetch.
          if (showsAirportOverlay(kind)) {
            overlays.push({
              color: AIRPORT_COLOR,
              refetchKm: AIRPORT_REFETCH_KM,
              load: (lat, lon) =>
                fetchOverlay(client, "airports", lat, lon).then((r) => {
                  onPlaces("airports", r.places);
                  return r.items;
                }),
              allowed: isApiAllowed,
            });
          }
          if (showsPortOverlay(kind)) {
            overlays.push({
              color: PORT_COLOR,
              refetchKm: PORT_REFETCH_KM,
              load: (lat, lon) =>
                fetchOverlay(client, "ports", lat, lon).then((r) => {
                  onPlaces("ports", r.places);
                  return r.items;
                }),
              allowed: isApiAllowed,
            });
          }
          let lookReferenced = false;
          globe = createSimGlobe(C, {
            container: el,
            kind: () => kindRef.current,
            marker: () => markerRef.current,
            pose: (now, terrain) => {
              const satrec = satrecRef.current;
              if (satrec) {
                const s = satelliteStateAt(satrec, new Date(now));
                if (s) trackerRef.current.update(satelliteSample(s, now), now);
              }
              const pose = trackerRef.current.pose(now, terrain);
              lastPose = pose;
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
          globeRef.current = globe;
          setEngineReady(true);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't start the 3D view.");
        });

      // --- drag to look around (pan/tilt mode: the phone aims the view), tap to pick traffic -------
      cleanups.push(
        attachLookGestures(el, {
          get: () => lookRef.current,
          set: (look) => {
            lookRef.current = look;
          },
          enabled: () => !deviceActiveRef.current,
          onReset: recenter,
          onTap: (x, y) => {
            const hit = globeRef.current?.pick(x, y);
            if (hit) selectRef.current(hit);
          },
        }),
      );

      return () => {
        cancelled = true;
        for (const fn of cleanups) fn();
        globe?.destroy();
        globe = null;
        globeRef.current = null;
        poseRef.current = null;
        setEngineReady(false);
        setFocused(false);
        setHud({ pose: null, name: "", look: LEVEL });
      };
    }, [surface, setPosition, recenter, sensorPoseRef, poseRef, onPlaces]),
  );

  const [cardHeight, setCardHeight] = useState(0);
  // The right-hand control column's width (the HUD stops left of it, src/sim/layout.ts hudMaxWidth).
  const [columnWidth, setColumnWidth] = useState(0);
  const onColumnLayout = useCallback((e: LayoutChangeEvent) => setColumnWidth(e.nativeEvent.layout.width), []);
  const layout = cockpitLayout({
    windowWidth: win.width,
    windowHeight: win.height,
    cardOpen: cockpit.selection != null,
    cardHeight,
  });

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
        data-camera={cockpit.cameraMode}
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
        navRows={cockpit.navRows}
        style={{
          maxWidth: hudMaxWidth({
            windowWidth: win.width,
            hudLeft: HUD_EDGE,
            columnRight: HUD_EDGE + layout.rightInset,
            columnWidth,
          }),
        }}
      />

      {pose && layout.minimapFits ? (
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
          style={{ right: 16 + layout.rightInset, bottom: 32 + layout.bottomInset }}
        />
      ) : null}

      <View
        testID="sim-controls"
        style={[styles.topRight, { right: HUD_EDGE + layout.rightInset }]}
        pointerEvents="box-none"
        onLayout={onColumnLayout}
      >
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
        <SimToggleChip
          testID="sim-camera-toggle"
          label="Outside view"
          accessibilityLabel="Outside view: watch from behind and above"
          on={cockpit.cameraMode === "chase"}
          onPress={cockpit.toggleCamera}
        />
        {cockpit.selection == null ? (
          <SimActionChip testID="sim-details" label="Details" onPress={cockpit.showDetails} />
        ) : null}
        <SimFilter
          chips={cockpit.chips}
          open={cockpit.filterOpen}
          onToggleOpen={cockpit.toggleFilter}
          onToggleLayer={cockpit.toggleLayer}
          summary={cockpit.filterSummary}
        />
      </View>

      {!isCentred(hud.look) ? (
        <Pressable testID="sim-recenter" style={styles.recenter} onPress={recenter}>
          <Text style={styles.recenterText}>↺ Recenter</Text>
          <Text testID="sim-look-offset" style={styles.recenterOffset}>
            {describeLook(hud.look)}
          </Text>
        </Pressable>
      ) : null}

      <SheetHeightContext.Provider value={setCardHeight}>
        <SimCard
          target={target}
          selection={cockpit.selection}
          onClose={cockpit.closeCard}
          onFollow={cockpit.follow}
          followedLost={!!pose?.stale}
          origin={pose}
          onRoute={cockpit.onRoute}
        />
      </SheetHeightContext.Provider>
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
