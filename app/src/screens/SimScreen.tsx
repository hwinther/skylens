/**
 * Simulator / cockpit view (Android). The 3D globe is the web view's Cesium scene running in a webview
 * as an Expo DOM component (components/SimGlobeView.tsx, scene code shared in src/sim/simGlobe.ts);
 * everything around it is native: the HUD (shared components/SimHud.tsx), the detail card (shared
 * components/SimCard.tsx), Exit / Map / Outside view / Layers / Recenter, the loading and failure
 * states, the place card (a tapped airport / port label, components/SimPlaceCard.tsx), and the Android
 * back button (closes the place or detail card first, then leaves).
 *
 * Data flow mirrors the web screen, but the webview shares no JS state with the app, so this screen
 * reads the live stores (the root layout re-centres the hub subscription on the target via simStore)
 * and passes each new sample to the globe as a prop. A native SimTracker drives the HUD and the
 * subscription centre at 4 Hz, so both keep working even when the globe can't start. Satellites: the
 * OMM is fetched here (the API and its auth stay native) and handed over; the globe propagates it per
 * frame. Airport/port labels are fetched here too, on request from the globe (a native action), and
 * their places kept for the HUD's nearest airport/port. The cockpit extras (components/useSimCockpit.ts)
 * cross as slim props: other traffic (only when it changed, ≤ 1 Hz), layer visibility, camera mode and
 * route destination; a tap on traffic comes back through the `onPick` action and opens its card, whose
 * "Follow this" re-targets the session (the globe stays up and starts a fresh tracker). A tapped label
 * comes back as { kind: "place", id: key }, resolved from the places this screen already holds.
 *
 * The session (target, tracker, subscriptions) and the globe's lifetime are separate focus effects
 * (tabs stay mounted), so a re-target doesn't reload the webview. Not on Android (yet): the minimap
 * inset (Leaflet; a "Map" button opens the full Map on the target instead) and the phone's pan/tilt
 * look mode (drag to look works inside the globe).
 */

import { color } from "@/theme";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SatRec } from "satellite.js";
import type { SatelliteOmm } from "@/api/types";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl } from "@/api/config";
import { orbitInfo, type OrbitClass } from "@/ar/orbitClass";
import { buildSatrec, satelliteStateAt } from "@/ar/satellites";
import { SheetHeightContext } from "@/components/Sheet";
import { SimCard } from "@/components/SimCard";
import { SimPlaceCard } from "@/components/SimPlaceCard";
import { SimActionChip, SimFilter, SimToggleChip } from "@/components/SimControls";
import SimGlobeView from "@/components/SimGlobeView";
import { SimHud, simHudStyles } from "@/components/SimHud";
import { useSimCockpit } from "@/components/useSimCockpit";
import { DIAG_TAG } from "@/sim/globeDiag";
import { statusText } from "@/sim/hud";
import { CENTRED_CONTROL_WIDTH, cockpitLayout, hudMaxWidth, placeCardInset, placeCardWidth } from "@/sim/layout";
import { describeLook, isCentred, type Look } from "@/sim/look";
import type { OverlayItem, OverlayLayerKind } from "@/sim/overlay";
import { fetchOverlay } from "@/sim/overlayData";
import { aircraftSample, satelliteSample, vesselSample, type SimSample } from "@/sim/simPose";
import { parseTarget } from "@/sim/target";
import { SimTracker, type TrackedPose } from "@/sim/tracker";
import type { SimPick } from "@/sim/place";
import type { TrafficItem } from "@/sim/traffic";
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

/**
 * Builds with EXPO_PUBLIC_SIM_DIAG=1 (the Maestro CI build) also put the globe's diagnostic summary on
 * a tiny, near-invisible `sim-globe-diag` text node, so Maestro's hierarchy dump and copyTextFrom can
 * read it. Every build logs it (logcat, tag ReactNativeJS, prefixed DIAG_TAG).
 */
const SHOW_DIAG = process.env.EXPO_PUBLIC_SIM_DIAG === "1";

/**
 * The webview re-receives ALL its props on every render of its parent (Expo DOM components emit them
 * unconditionally), and this screen re-renders at the HUD's 4 Hz. Memoised, the globe only hears about
 * real changes: a new sample, the OMM, recenter, access, new traffic (≤ 1 Hz), the filter, the camera
 * mode, the destination, or its (stable) callbacks.
 */
const Globe = memo(SimGlobeView);

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
  const win = useWindowDimensions();
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
  const [imageryReason, setImageryReason] = useState<string | null>(null);
  const [diag, setDiag] = useState("");
  const [look, setLook] = useState<Look>(LEVEL);
  const [recenterSeq, setRecenterSeq] = useState(0);
  const [traffic, setTraffic] = useState<TrafficItem[]>([]);
  const [cardHeight, setCardHeight] = useState(0);
  // The right-hand control column's width (the HUD stops left of it, src/sim/layout.ts hudMaxWidth).
  const [columnWidth, setColumnWidth] = useState(0);
  const onColumnLayout = useCallback((e: LayoutChangeEvent) => setColumnWidth(e.nativeEvent.layout.width), []);
  const nameRef = useRef("");
  // The session's state, read by the HUD timer (which outlives a re-target).
  const trackerRef = useRef(new SimTracker());
  const satrecRef = useRef<SatRec | null>(null);

  // Card, filter, camera mode, traffic and nav aids (shared with the web screen).
  // An empty set stays the same array, so "still no traffic" doesn't re-render the globe.
  const onTraffic = useCallback(
    (items: TrafficItem[]) => setTraffic((prev) => (prev.length === 0 && items.length === 0 ? prev : items)),
    [],
  );
  const cockpit = useSimCockpit({ target, focused, onTraffic });
  const { poseRef, onPlaces, pick } = cockpit;

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

  // Android back: an open card (place or detail) closes first (as everywhere in the app), then back
  // leaves the cockpit view the same way Exit does (the tab navigator would otherwise jump to the first
  // tab). This listener can be registered after the card's own one, so it handles the card itself.
  const cardOpenRef = useRef(false);
  const placeOpenRef = useRef(false);
  useEffect(() => {
    cardOpenRef.current = cockpit.selection != null;
    placeOpenRef.current = cockpit.place != null;
  }, [cockpit.selection, cockpit.place]);
  const { closeCard, closePlace } = cockpit;
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (placeOpenRef.current) closePlace();
        else if (cardOpenRef.current) closeCard();
        else exit();
        return true;
      });
      return () => sub.remove();
    }, [exit, closeCard, closePlace]),
  );

  // --- the session: target, tracker, subscriptions (re-run on "Follow this") ------------------------
  useFocusEffect(
    useCallback(() => {
      if (!target) return;
      start(target);
      const tracker = new SimTracker();
      trackerRef.current = tracker;
      satrecRef.current = null;
      let cancelled = false;
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
        nameRef.current = target.id.toUpperCase();
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
        nameRef.current = `MMSI ${target.id}`;
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
              satrecRef.current = buildSatrec(detail.satellite.omm);
              setOrbitClass(orbitInfo(detail.satellite.omm)?.class ?? null);
              nameRef.current = detail.satellite.name?.trim() || nameRef.current;
              if (satrecRef.current) setOmm(detail.satellite.omm);
              else setError("This satellite's orbit can't be propagated.");
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
        setSample(null);
        setOmm(null);
        setOrbitClass(null);
        setError(null);
        setLook(LEVEL);
        stop();
      };
    }, [target, start, stop, setPosition]),
  );

  // --- the globe's lifetime and the HUD: tied to focus only ---------------------------------------
  const hasTarget = target != null;
  useFocusEffect(
    useCallback(() => {
      if (!hasTarget) return;
      setFocused(true);
      // HUD + subscription centre at 4 Hz.
      const hudTimer = setInterval(() => {
        const now = Date.now();
        const satrec = satrecRef.current;
        if (satrec) {
          const s = satelliteStateAt(satrec, new Date(now));
          if (s) trackerRef.current.update(satelliteSample(s, now), now);
        }
        const pose = trackerRef.current.pose(now);
        if (pose) setPosition(pose.lat, pose.lon);
        poseRef.current = pose;
        setHud({ pose, name: nameRef.current });
      }, HUD_MS);

      return () => {
        clearInterval(hudTimer);
        poseRef.current = null;
        setFocused(false);
        setPhase("loading");
        setGlobeError(null);
        setImagery(null);
        setImageryReason(null);
        setDiag("");
        setLook(LEVEL);
        setTraffic([]);
        setHud({ pose: null, name: "" });
      };
    }, [hasTarget, setPosition, poseRef]),
  );

  // A globe that never reports back (webview stuck, page never ran) still ends in the failure state.
  useEffect(() => {
    if (!focused || phase !== "loading") return;
    const timer = setTimeout(() => {
      console.log(`${DIAG_TAG} globe start timed out`);
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
      const { items, places } = await fetchOverlay(client, layer, lat, lon);
      onPlaces(layer, places);
      return items;
    },
    [client, onPlaces],
  );
  const onReady = useCallback(async () => {
    console.log(`${DIAG_TAG} globe ready`);
    setPhase((p) => (p === "failed" ? p : "ready"));
  }, []);
  const onFailed = useCallback(async (message: string) => {
    console.log(`${DIAG_TAG} globe failed: ${message}`);
    setGlobeError(message);
    setPhase("failed");
  }, []);
  const onImagery = useCallback(async (state: "loaded" | "failed", reason?: string) => {
    console.log(`${DIAG_TAG} imagery ${state}${reason ? `: ${reason}` : ""}`);
    setImagery(state);
    setImageryReason(reason ?? null);
  }, []);
  const onDiagnostic = useCallback(async (summary: string) => {
    console.log(`${DIAG_TAG} ${summary}`);
    setDiag(summary);
  }, []);
  const onLook = useCallback(async (next: Look) => {
    setLook(next);
  }, []);
  const onPick = useCallback(
    async (hit: SimPick | null) => {
      pick(hit);
    },
    [pick],
  );
  const recenter = useCallback(() => {
    setLook(LEVEL);
    setRecenterSeq((n) => n + 1);
  }, []);
  const onRenderProcessGone = useCallback(() => {
    console.log(`${DIAG_TAG} webview render process gone`);
    setGlobeError("The 3D view crashed.");
    setPhase("failed");
  }, []);
  const domProps = useMemo(
    () => ({
      style: styles.globe,
      scrollEnabled: false,
      overScrollMode: "never" as const,
      contentInsetAdjustmentBehavior: "never" as const,
      // The webview's renderer died (out of memory, GPU crash): the failure state, not a blank.
      onRenderProcessGone,
    }),
    [onRenderProcessGone],
  );

  const layout = cockpitLayout({
    windowWidth: win.width,
    windowHeight: win.height,
    cardOpen: cockpit.selection != null,
    cardHeight,
  });
  const [placeHeight, setPlaceHeight] = useState(0);
  const onPlaceLayout = useCallback((e: LayoutChangeEvent) => setPlaceHeight(e.nativeEvent.layout.height), []);

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
  const hudLeft = insets.left + 12;
  const columnRight = insets.right + 12 + layout.rightInset;
  const pose = hud.pose;
  // The place card sits bottom-left; Recenter (bottom-centre) moves above it where they'd collide.
  const placeWidth = placeCardWidth(win.width, hudLeft, insets.right + 12);
  const placeBottom = insets.bottom + 24;
  const placeInset = cockpit.place
    ? placeCardInset({
        cardRight: hudLeft + placeWidth,
        cardHeight: placeHeight,
        controlLeft: (win.width - CENTRED_CONTROL_WIDTH) / 2,
      })
    : 0;
  return (
    <View style={styles.root} testID="sim-screen">
      <View
        testID={`sim-globe-${phase}`}
        accessibilityLabel={`3D globe ${phase}${imagery ? `, imagery ${imagery}` : ""}`}
        style={StyleSheet.absoluteFill}
        collapsable={false}
      >
        {focused && phase !== "failed" ? (
          <Globe
            // Rebuilt only between surface and orbit (their label layers differ); "Follow this"
            // between aircraft and vessels keeps the engine and changes targetKey instead.
            key={target.kind === "satellite" ? "orbit" : "surface"}
            kind={target.kind}
            targetKey={`${target.kind}:${target.id}`}
            sample={sample}
            omm={omm}
            recenter={recenterSeq}
            apiAllowed={apiAllowed}
            traffic={traffic}
            layers={cockpit.visibility}
            cameraMode={cockpit.cameraMode}
            destination={cockpit.destination}
            loadOverlay={loadOverlay}
            onReady={onReady}
            onFailed={onFailed}
            onImagery={onImagery}
            onLook={onLook}
            onPick={onPick}
            onDiagnostic={onDiagnostic}
            dom={domProps}
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
        navRows={cockpit.navRows}
        style={{ top, left: hudLeft, maxWidth: hudMaxWidth({ windowWidth: win.width, hudLeft, columnRight, columnWidth }) }}
      >
        {imagery === "failed" ? (
          <Text testID="sim-imagery-failed" style={simHudStyles.note}>
            Map imagery unavailable ({imageryReason ?? "offline?"})
          </Text>
        ) : null}
      </SimHud>

      <View
        testID="sim-controls"
        style={[styles.topRight, { top, right: columnRight }]}
        pointerEvents="box-none"
        onLayout={onColumnLayout}
      >
        <Pressable testID="sim-exit" style={styles.exit} onPress={exit}>
          <Text style={styles.exitText}>Exit</Text>
        </Pressable>
        <SimActionChip
          testID="sim-open-map"
          label="Map"
          accessibilityLabel="Open on the map"
          onPress={openOnMap}
        />
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

      {SHOW_DIAG && diag ? (
        <Text testID="sim-globe-diag" style={styles.diag} pointerEvents="none">
          {diag}
        </Text>
      ) : null}

      {!isCentred(look) ? (
        <Pressable
          testID="sim-recenter"
          style={[styles.recenter, { bottom: insets.bottom + 24 + layout.bottomInset + placeInset }]}
          onPress={recenter}
        >
          <Text style={styles.recenterText}>↺ Recenter</Text>
          <Text testID="sim-look-offset" style={styles.recenterOffset}>
            {describeLook(look)}
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

      {cockpit.place ? (
        <SimPlaceCard
          place={cockpit.place}
          origin={pose}
          onClose={closePlace}
          onLayout={onPlaceLayout}
          style={{ left: hudLeft, bottom: placeBottom, width: placeWidth }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  // Present for the hierarchy dump (non-zero size and alpha), practically invisible on screen.
  diag: { position: "absolute", left: 0, bottom: 0, width: 4, height: 4, fontSize: 1, opacity: 0.02, color: "#000" },
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
