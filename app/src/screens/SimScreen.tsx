/**
 * Simulator / cockpit view (Android). The 3D globe is the web view's Cesium scene running in a webview
 * as an Expo DOM component (components/SimGlobeView.tsx, scene code shared in src/sim/simGlobe.ts);
 * everything around it is native: the HUD (shared components/SimHud.tsx), Exit / Map / Recenter, the
 * loading and failure states, and the Android back button.
 *
 * Data flow mirrors the web screen, but the webview shares no JS state with the app, so this screen
 * reads the live stores (the root layout re-centres the hub subscription on the target via simStore)
 * and passes each new sample to the globe as a prop. A native SimTracker drives the HUD and the
 * subscription centre at 4 Hz, so both keep working even when the globe can't start. Satellites: the
 * OMM is fetched here (the API and its auth stay native) and handed over; the globe propagates it per
 * frame. Airport/port labels are fetched here too, on request from the globe (a native action).
 *
 * The globe, the session and the subscriptions are tied to screen focus, like on the web (tabs stay
 * mounted). Not on Android (yet): the minimap inset (Leaflet; a "Map" button opens the full Map on the
 * target instead) and the phone's pan/tilt look mode (drag to look works inside the globe).
 */

import { color } from "@/theme";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SatRec } from "satellite.js";
import type { SatelliteOmm } from "@/api/types";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl } from "@/api/config";
import { orbitInfo, type OrbitClass } from "@/ar/orbitClass";
import { buildSatrec, satelliteStateAt } from "@/ar/satellites";
import SimGlobeView from "@/components/SimGlobeView";
import { SimHud, simHudStyles } from "@/components/SimHud";
import { statusText } from "@/sim/hud";
import { describeLook, isCentred, type Look } from "@/sim/look";
import type { OverlayItem, OverlayLayerKind } from "@/sim/overlay";
import { fetchOverlayItems } from "@/sim/overlayData";
import { aircraftSample, satelliteSample, vesselSample, type SimSample } from "@/sim/simPose";
import { parseTarget } from "@/sim/target";
import { SimTracker, type TrackedPose } from "@/sim/tracker";
import { useAircraftStore } from "@/state/aircraftStore";
import { isApiAllowed, useApiAllowed } from "@/state/authStore";
import { useMapFocusStore } from "@/state/mapFocusStore";
import { useSatelliteTrackStore } from "@/state/satelliteTrackStore";
import { useSimStore } from "@/state/simStore";
import { useVesselStore } from "@/state/vesselStore";

/** HUD refresh rate. */
const HUD_MS = 250;
/**
 * The globe counts as failed if it hasn't rendered a frame by then. Generous: a cold webview parses
 * ~6 MB of Cesium.js, and a CI emulator renders WebGL in software.
 */
export const GLOBE_START_TIMEOUT_MS = 60_000;

const LEVEL: Readonly<Look> = Object.freeze({ yaw: 0, pitch: 0 });

type GlobePhase = "loading" | "ready" | "failed";

interface Hud {
  pose: TrackedPose | null;
  name: string;
}

export default function SimScreen() {
  const params = useLocalSearchParams<{ kind?: string; id?: string }>();
  const target = useMemo(() => parseTarget(params.kind, params.id), [params.kind, params.id]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const start = useSimStore((s) => s.start);
  const stop = useSimStore((s) => s.stop);
  const setPosition = useSimStore((s) => s.setPosition);
  const apiAllowed = useApiAllowed();

  const [focused, setFocused] = useState(false);
  const [hud, setHud] = useState<Hud>({ pose: null, name: "" });
  const [sample, setSample] = useState<SimSample | null>(null);
  const [omm, setOmm] = useState<SatelliteOmm | null>(null);
  const [orbitClass, setOrbitClass] = useState<OrbitClass | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<GlobePhase>("loading");
  const [globeError, setGlobeError] = useState<string | null>(null);
  const [imagery, setImagery] = useState<"loaded" | "failed" | null>(null);
  const [look, setLook] = useState<Look>(LEVEL);
  const [recenterSeq, setRecenterSeq] = useState(0);
  const nameRef = useRef("");

  const exit = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [router]);

  // "Map": hand the target to the full Map (aircraft/vessel follow, satellite ground track).
  const setMapFocus = useMapFocusStore((s) => s.setFocus);
  const setTrackedSatellite = useSatelliteTrackStore((s) => s.setTracked);
  const openOnMap = useCallback(() => {
    if (!target) return;
    if (target.kind === "aircraft") setMapFocus({ kind: "aircraft", hex: target.id });
    else if (target.kind === "vessel") setMapFocus({ kind: "vessel", mmsi: target.id });
    else setTrackedSatellite(Number(target.id));
    router.push("/map");
  }, [target, setMapFocus, setTrackedSatellite, router]);

  // Android back leaves the cockpit view the same way Exit does (the tab navigator would otherwise
  // jump to the first tab).
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        exit();
        return true;
      });
      return () => sub.remove();
    }, [exit]),
  );

  useFocusEffect(
    useCallback(() => {
      if (!target) return;
      setFocused(true);
      start(target);
      const tracker = new SimTracker();
      let cancelled = false;
      let satrec: SatRec | null = null;
      const cleanups: (() => void)[] = [];

      if (target.kind === "aircraft") {
        const feed = (s: ReturnType<typeof useAircraftStore.getState>) => {
          const ac = s.byHex[target.id];
          if (!ac) return;
          nameRef.current = ac.flight?.trim() || target.id.toUpperCase();
          const next = aircraftSample(ac, s.lastSnapshotAt || Date.now());
          if (!next) return;
          tracker.update(next, Date.now());
          setSample(next);
        };
        feed(useAircraftStore.getState());
        cleanups.push(useAircraftStore.subscribe(feed));
      } else if (target.kind === "vessel") {
        const feed = (s: ReturnType<typeof useVesselStore.getState>) => {
          const v = s.byMmsi[target.id];
          if (!v) return;
          nameRef.current = v.name?.trim() || `MMSI ${target.id}`;
          const next = vesselSample(v, s.lastSnapshotAt || Date.now());
          if (!next) return;
          tracker.update(next, Date.now());
          setSample(next);
        };
        feed(useVesselStore.getState());
        cleanups.push(useVesselStore.subscribe(feed));
      } else {
        nameRef.current = `NORAD ${target.id}`;
        if (!isApiAllowed()) {
          // Signed out behind real auth: no API calls, so the orbit can't be loaded.
          setError("Sign in to load the satellite's orbit.");
        } else {
          new ApiClient({ baseUrl: getApiBaseUrl() })
            .satelliteDetail(Number(target.id))
            .then((detail) => {
              if (cancelled) return;
              satrec = buildSatrec(detail.satellite.omm);
              setOrbitClass(orbitInfo(detail.satellite.omm)?.class ?? null);
              nameRef.current = detail.satellite.name?.trim() || nameRef.current;
              if (satrec) setOmm(detail.satellite.omm);
              else setError("This satellite's orbit can't be propagated.");
            })
            .catch(() => {
              if (!cancelled) setError("Couldn't load the satellite's orbit.");
            });
        }
      }

      // HUD + subscription centre at 4 Hz.
      const hudTimer = setInterval(() => {
        const now = Date.now();
        if (satrec) {
          const s = satelliteStateAt(satrec, new Date(now));
          if (s) tracker.update(satelliteSample(s, now), now);
        }
        const pose = tracker.pose(now);
        if (pose) setPosition(pose.lat, pose.lon);
        setHud({ pose, name: nameRef.current });
      }, HUD_MS);
      cleanups.push(() => clearInterval(hudTimer));

      return () => {
        cancelled = true;
        for (const fn of cleanups) fn();
        setFocused(false);
        setSample(null);
        setOmm(null);
        setOrbitClass(null);
        setError(null);
        setPhase("loading");
        setGlobeError(null);
        setImagery(null);
        setLook(LEVEL);
        setHud({ pose: null, name: "" });
        stop();
      };
    }, [target, start, stop, setPosition]),
  );

  // A globe that never reports back (webview stuck, page never ran) still ends in the failure state.
  useEffect(() => {
    if (!focused || phase !== "loading") return;
    const timer = setTimeout(() => {
      setGlobeError("The 3D view didn't start in time.");
      setPhase("failed");
    }, GLOBE_START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [focused, phase]);

  // --- native actions for the globe (async: they cross the webview bridge) -------------------------
  const client = useMemo(() => new ApiClient({ baseUrl: getApiBaseUrl() }), []);
  const loadOverlay = useCallback(
    async (layer: OverlayLayerKind, lat: number, lon: number): Promise<OverlayItem[]> => {
      // Rejecting (not an empty list) makes the globe retry once access returns.
      if (!isApiAllowed()) throw new Error("API not allowed");
      return fetchOverlayItems(client, layer, lat, lon);
    },
    [client],
  );
  const onReady = useCallback(async () => {
    setPhase((p) => (p === "failed" ? p : "ready"));
  }, []);
  const onFailed = useCallback(async (message: string) => {
    setGlobeError(message);
    setPhase("failed");
  }, []);
  const onImagery = useCallback(async (state: "loaded" | "failed") => {
    setImagery(state);
  }, []);
  const onLook = useCallback(async (next: Look) => {
    setLook(next);
  }, []);
  const recenter = useCallback(() => {
    setLook(LEVEL);
    setRecenterSeq((n) => n + 1);
  }, []);
  const onRenderProcessGone = useCallback(() => {
    setGlobeError("The 3D view crashed.");
    setPhase("failed");
  }, []);

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

  const top = insets.top + 12;
  const pose = hud.pose;
  return (
    <View style={styles.root} testID="sim-screen">
      <View
        testID={`sim-globe-${phase}`}
        accessibilityLabel={`3D globe ${phase}${imagery ? `, imagery ${imagery}` : ""}`}
        style={StyleSheet.absoluteFill}
        collapsable={false}
      >
        {focused && phase !== "failed" ? (
          <SimGlobeView
            key={`${target.kind}:${target.id}`}
            kind={target.kind}
            sample={sample}
            omm={omm}
            recenter={recenterSeq}
            apiAllowed={apiAllowed}
            loadOverlay={loadOverlay}
            onReady={onReady}
            onFailed={onFailed}
            onImagery={onImagery}
            onLook={onLook}
            dom={{
              style: styles.globe,
              scrollEnabled: false,
              overScrollMode: "never",
              contentInsetAdjustmentBehavior: "never",
              // The webview's renderer died (out of memory, GPU crash): the failure state, not a blank.
              onRenderProcessGone,
            }}
          />
        ) : null}
      </View>

      {phase === "loading" ? (
        <View style={styles.overlayCenter} pointerEvents="none" testID="sim-globe-spinner">
          <ActivityIndicator size="large" color={color.text} />
          <Text style={styles.loadingText}>Starting the 3D globe…</Text>
        </View>
      ) : null}

      {phase === "failed" ? (
        <View style={styles.overlayCenter} pointerEvents="box-none">
          <View style={styles.failCard} testID="sim-globe-error">
            <Text style={styles.failTitle}>3D view unavailable</Text>
            <Text style={styles.message}>{globeError ?? "The 3D view couldn't start."}</Text>
            <Pressable testID="sim-globe-back" style={styles.exit} onPress={exit}>
              <Text style={styles.exitText}>Back</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <SimHud
        kind={target.kind}
        name={hud.name}
        pose={pose}
        orbitClass={orbitClass}
        status={statusText(pose, phase === "ready", error)}
        style={{ top, left: insets.left + 12 }}
      >
        {imagery === "failed" ? (
          <Text testID="sim-imagery-failed" style={simHudStyles.note}>
            Map imagery unavailable (offline?)
          </Text>
        ) : null}
      </SimHud>

      <View style={[styles.topRight, { top, right: insets.right + 12 }]} pointerEvents="box-none">
        <Pressable testID="sim-exit" style={styles.exit} onPress={exit}>
          <Text style={styles.exitText}>Exit</Text>
        </Pressable>
        <Pressable testID="sim-open-map" style={styles.chip} onPress={openOnMap}>
          <Text style={styles.chipText}>Map</Text>
        </Pressable>
      </View>

      {!isCentred(look) ? (
        <Pressable
          testID="sim-recenter"
          style={[styles.recenter, { bottom: insets.bottom + 24 }]}
          onPress={recenter}
        >
          <Text style={styles.recenterText}>↺ Recenter</Text>
          <Text testID="sim-look-offset" style={styles.recenterOffset}>
            {describeLook(look)}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  globe: { flex: 1, backgroundColor: "#000" },
  center: {
    flex: 1,
    backgroundColor: color.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 16,
  },
  overlayCenter: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  loadingText: { color: color.textDim, fontSize: 15 },
  failCard: {
    alignItems: "center",
    gap: 12,
    padding: 20,
    borderRadius: 14,
    backgroundColor: "rgba(11, 22, 34, 0.92)",
    maxWidth: 360,
  },
  failTitle: { color: color.text, fontSize: 18, fontWeight: "700" },
  message: { color: color.textDim, fontSize: 15, textAlign: "center" },
  exit: {
    backgroundColor: color.accentFill,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  exitText: { color: color.text, fontSize: 15, fontWeight: "600" },
  topRight: { position: "absolute", alignItems: "flex-end", gap: 8 },
  chip: {
    backgroundColor: "rgba(11, 22, 34, 0.72)",
    borderColor: color.textMuted,
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  chipText: { color: color.textDim, fontSize: 13, fontWeight: "600" },
  recenter: {
    position: "absolute",
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
});
