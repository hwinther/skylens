/**
 * AR view — the home screen. Renders the live camera (or a static sky in demo mode)
 * with the aircraft overlay on top, a status strip, and a tap-to-open detail sheet.
 *
 * Two pose sources:
 *  - live: usePoseRefs subscribes to DeviceMotion (~60 Hz) + location/heading (native only).
 *  - drag: useDemoPose drives the pose from a drag gesture. Used in demo mode AND on web —
 *    which has no orientation sensor — so you can look around without a compass/gyro.
 *
 * The 1 Hz aircraft list lives in zustand; the 60 Hz pose lives in refs (never in
 * zustand) and is consumed by the overlay's rAF loop.
 */

import { useEffect, useMemo, useState } from "react";
import { ImageBackground, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { WebCameraView } from "@/components/WebCameraView";
import { useWebArSensors } from "@/components/useWebArSensors";
import {
  AirportDetailSheet,
  ArOverlay,
  DetailSheet,
  PlanetDetailSheet,
  SatelliteDetailSheet,
  StatusStrip,
  useAirports,
  useDemoPose,
  useObserverLocation,
  usePlanets,
  usePoseRefs,
  useSatellites,
} from "@/components";
import { airportFilter } from "@/components/webmap/airportStyle";
import { satGroupsFromSettings } from "@/ar";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl } from "@/api/config";
import { startMockFeed, DEMO_HOME } from "@/mock/mockFeed";
import {
  useAircraftList,
  useAircraftStore,
} from "@/state/aircraftStore";
import { useVesselList, useVesselStore } from "@/state/vesselStore";
import { useSettingsStore } from "@/state/settingsStore";

export default function ArScreen() {
  const demoMode = useSettingsStore((s) => s.demoMode);
  const hFovDeg = useSettingsStore((s) => s.hFovDeg);
  const trimDeg = useSettingsStore((s) => s.azimuthTrimDeg);
  const showShips = useSettingsStore((s) => s.showShips);
  const showAton = useSettingsStore((s) => s.showAton);
  const showSatellites = useSettingsStore((s) => s.showSatellites);
  const satAmateurStations = useSettingsStore((s) => s.satAmateurStations);
  const satWeather = useSettingsStore((s) => s.satWeather);
  const satGnss = useSettingsStore((s) => s.satGnss);
  const satElevationMaskDeg = useSettingsStore((s) => s.satElevationMaskDeg);
  const showPlanets = useSettingsStore((s) => s.showPlanets);
  const showEcliptic = useSettingsStore((s) => s.showEcliptic);
  const showAirports = useSettingsStore((s) => s.showAirports);
  const showSmallAirfields = useSettingsStore((s) => s.showSmallAirfields);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [selectedPlanet, setSelectedPlanet] = useState<string | null>(null);
  const [selectedAirportIdent, setSelectedAirportIdent] = useState<string | null>(null);
  // Selected satellite for the Phase 5 detail sheet. Captured now so the overlay's tap wiring is
  // complete; the sheet itself mounts in Phase 5 (see the placeholder near <DetailSheet/> below).
  const [selectedNoradId, setSelectedNoradId] = useState<number | null>(null);

  const baseUrl = useMemo(() => getApiBaseUrl(), []);
  // Live-mode observer: baked home coords, else a one-shot device/browser geolocation fix
  // (same source the root layout's hub subscription uses).
  const observer = useObserverLocation(!demoMode);

  // First-run / degraded AR hints (item 03), native live mode only — demo & web show neither.
  // `observer` is null until the first GPS fix; `cameraPermission` is reactive from the hook above.
  const acquiringFix = !demoMode && Platform.OS !== "web" && !observer;
  const cameraDenied =
    !demoMode && Platform.OS !== "web" && cameraPermission?.status === "denied";

  const aircraft = useAircraftList();
  const snapshotAt = useAircraftStore((s) => s.lastSnapshotAt);
  const vessels = useVesselList();
  const vesselsSnapshotAt = useVesselStore((s) => s.lastSnapshotAt);
  const connection = useAircraftStore((s) => s.connection);
  const source = useAircraftStore((s) => s.source);
  const setSnapshot = useAircraftStore((s) => s.setSnapshot);
  const setSource = useAircraftStore((s) => s.setSource);
  const setConnection = useAircraftStore((s) => s.setConnection);

  const client = useMemo(() => new ApiClient({ baseUrl }), [baseUrl]);

  // Enabled satellite groups, derived from the three settings toggles (shared with the List screen).
  const satGroups = useMemo(
    () =>
      satGroupsFromSettings({
        amateurStations: satAmateurStations,
        weather: satWeather,
        gnss: satGnss,
      }),
    [satAmateurStations, satWeather, satGnss],
  );

  // Satellites render in BOTH demo and live mode (they're independent of the ADS-B hub), so the hook
  // is gated only on the showSatellites toggle. Observer is the demo home in demo mode, else the
  // live GPS/browser fix.
  const satHook = useSatellites({
    client,
    observer: demoMode ? DEMO_HOME : observer,
    enabled: showSatellites,
    groups: satGroups,
    elevationMaskDeg: satElevationMaskDeg,
  });

  // Planets are pure on-device astronomy (no hub, no network), so — like satellites — they run in demo
  // and live alike, gated only on the toggle. Observer = demo home in demo mode, else the live fix.
  const planetHook = usePlanets({
    observer: demoMode ? DEMO_HOME : observer,
    enabled: showPlanets || showEcliptic,
  });

  // Airports render in both demo and live (static reference data, independent of the hub), gated only on
  // the toggle. Observer = demo home in demo mode, else the live fix — same as satellites/planets.
  const airports = useAirports({
    client,
    observer: demoMode ? DEMO_HOME : observer,
    enabled: showAirports,
  });
  // Apply the small-airfields toggle (the same memo the map screens use) before handing the set to the overlay.
  const shownAirports = useMemo(
    () => airports.filter((a) => airportFilter(a.type, showSmallAirfields)),
    [airports, showSmallAirfields],
  );

  // Live sensor pose (only active when not in demo mode).
  const live = usePoseRefs({ trimDeg, enabled: !demoMode });
  // Drag-to-look pose (demo mode, and web live without working sensors — the fallback).
  const demo = useDemoPose({ initialAzimuth: 90 });
  // Web live AR: real rear camera + compass/gyro pose on a mobile browser. No-op on native
  // and desktop web (returns "unavailable"), where the existing drag path is untouched.
  const webAr = useWebArSensors({ enabled: !demoMode && Platform.OS === "web", trimDeg });

  // The web AR pose only takes over once the browser sensor is actually streaming.
  const webArActive = Platform.OS === "web" && !demoMode && webAr.status === "active";
  // The camera turns on when sensors are active (Android) OR the moment the user taps Enable
  // on iOS — the camera-permission prompt must ride the same user gesture as the compass one.
  const [webArEnableTapped, setWebArEnableTapped] = useState(false);
  const [webCamDenied, setWebCamDenied] = useState(false);
  const webCamWanted =
    Platform.OS === "web" && !demoMode && (webArActive || webArEnableTapped);
  const webCamShown = webCamWanted && !webCamDenied;

  // Web AR active → the sensor pose ref; otherwise demo (drag) on web/demo, live on native.
  const useDragPose = demoMode || (Platform.OS === "web" && !webArActive);
  const poseRef = webArActive ? webAr.poseRef : useDragPose ? demo.poseRef : live.poseRef;
  // usePoseRefs returns a fresh object each render, but setObserverPosition is a
  // stable useCallback — depend on it, not on `live`, or the effect re-runs every
  // render and thrashes setConnection.
  const { setObserverPosition } = live;

  useEffect(() => {
    if (!demoMode) return;
    // Demo: replay recorded feed, fabricate a fixed observer at the series home.
    setSource("demo");
    setConnection("connected");
    setObserverPosition({ lat: DEMO_HOME.lat, lon: DEMO_HOME.lon, alt: 100 });
    const handle = startMockFeed({
      onSnapshot: (a) => setSnapshot(a),
    });
    return () => {
      handle.stop();
      setConnection("disconnected");
    };
  }, [demoMode, setSnapshot, setSource, setConnection, setObserverPosition]);

  useEffect(() => {
    if (demoMode) return;
    // Seed the projection origin so the overlay can place aircraft before (or instead of) the
    // native GPS watch — on web the one-shot browser fix from useObserverLocation is all we get.
    // useLiveFeed sets the source.
    if (observer)
      setObserverPosition({ lat: observer.lat, lon: observer.lon, alt: observer.alt ?? 0 });
    if (!cameraPermission?.granted) void requestCameraPermission();
  }, [demoMode, observer, setObserverPosition, cameraPermission?.granted, requestCameraPermission]);

  const overlay = (
    <ArOverlay
      aircraft={aircraft}
      snapshotAt={snapshotAt}
      vessels={vessels}
      vesselsSnapshotAt={vesselsSnapshotAt}
      showShips={showShips}
      showAton={showAton}
      satellites={satHook.visible}
      satellitesSampledAt={satHook.satellitesSampledAt}
      showSatellites={showSatellites}
      planets={planetHook.visible}
      showPlanets={showPlanets}
      ecliptic={planetHook.ecliptic}
      showEcliptic={showEcliptic}
      onSelectPlanet={setSelectedPlanet}
      airports={shownAirports}
      showAirports={showAirports}
      onSelectAirport={setSelectedAirportIdent}
      poseRef={poseRef}
      positionRef={live.positionRef}
      hFovDeg={hFovDeg}
      onSelect={setSelectedHex}
      onSelectSatellite={setSelectedNoradId}
      // No camera feed (native without permission, or web without a working AR camera) → synthetic horizon.
      showHorizon={!demoMode && !cameraPermission?.granted && !webCamShown}
    />
  );

  return (
    <View style={styles.root}>
      {demoMode ? (
        <GestureDetector gesture={demo.gesture}>
          <ImageBackground source={require("../assets/sky.png")} style={StyleSheet.absoluteFill}>
            {overlay}
          </ImageBackground>
        </GestureDetector>
      ) : Platform.OS === "web" ? (
        // Live on web. On a mobile browser we can do real AR (rear camera + compass/gyro);
        // desktop and unsupported/denied cases fall back to drag-to-look over a dark sky.
        <>
          {webCamWanted ? (
            <WebCameraView active onStatus={(s) => setWebCamDenied(s === "denied")} />
          ) : null}
          {webArActive ? (
            // Sensors drive the pose — no drag gesture, camera preview sits behind the overlay.
            overlay
          ) : (
            <GestureDetector gesture={demo.gesture}>
              <View style={[StyleSheet.absoluteFill, !webCamShown && styles.noCam]}>{overlay}</View>
            </GestureDetector>
          )}
          {webAr.status === "needs-permission" ? (
            <View style={styles.enableWrap} pointerEvents="box-none">
              <Pressable
                testID="web-ar-enable"
                style={styles.enableButton}
                onPress={() => {
                  setWebArEnableTapped(true);
                  void webAr.request();
                }}
              >
                <Text style={styles.enableText}>Enable AR (camera + compass)</Text>
              </Pressable>
            </View>
          ) : null}
        </>
      ) : cameraPermission?.granted ? (
        // CameraView doesn't support children — the overlay is absoluteFill, so render it as a
        // sibling on top instead.
        <>
          <CameraView style={StyleSheet.absoluteFill} facing="back" />
          {overlay}
        </>
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.noCam]}>{overlay}</View>
      )}

      <SafeAreaView edges={["top"]} style={styles.top}>
        <StatusStrip
          gpsAccuracyM={live.gpsAccuracyRef.current}
          headingAccuracy={live.headingAccuracyRef.current}
          azimuthTrimDeg={trimDeg}
          source={source}
          connection={connection}
          aircraftCount={aircraft.filter((a) => a.lat != null).length}
        />
      </SafeAreaView>

      {cameraDenied ? (
        <SafeAreaView edges={["top"]} style={styles.bannerWrap} pointerEvents="box-none">
          <Pressable style={styles.banner} onPress={() => router.push("/settings")} hitSlop={6}>
            <MaterialCommunityIcons name="camera-off" size={16} color="#FFD37C" />
            <Text style={styles.bannerText}>Camera off — showing synthetic horizon. Tap to enable.</Text>
          </Pressable>
        </SafeAreaView>
      ) : null}

      {acquiringFix ? (
        <View style={styles.acquireWrap} pointerEvents="box-none">
          <View style={styles.acquirePill}>
            <MaterialCommunityIcons name="crosshairs-gps" size={16} color="#78C8FF" />
            <Text style={styles.acquireText}>Acquiring position…</Text>
          </View>
          <Text style={styles.acquireSub}>Step outside for a clear view of the sky.</Text>
        </View>
      ) : null}

      <DetailSheet hex={selectedHex} client={client} onClose={() => setSelectedHex(null)} />
      <SatelliteDetailSheet
        noradId={selectedNoradId}
        view={selectedNoradId != null ? satHook.byNoradId.get(selectedNoradId) : undefined}
        observer={demoMode ? DEMO_HOME : observer}
        elevationMaskDeg={satElevationMaskDeg}
        onClose={() => setSelectedNoradId(null)}
      />
      <PlanetDetailSheet
        body={selectedPlanet}
        view={selectedPlanet != null ? planetHook.byBody.get(selectedPlanet) : undefined}
        observer={demoMode ? DEMO_HOME : observer}
        onClose={() => setSelectedPlanet(null)}
      />
      <AirportDetailSheet
        ident={selectedAirportIdent}
        airport={
          selectedAirportIdent != null
            ? airports.find((a) => a.ident === selectedAirportIdent)
            : undefined
        }
        onClose={() => setSelectedAirportIdent(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B1622" },
  top: { position: "absolute", top: 0, left: 0, right: 0, pointerEvents: "box-none" },
  noCam: { backgroundColor: "#0B1622" },
  // Centered iOS "Enable AR" pill — the user gesture that unlocks camera + compass permission.
  enableWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  enableButton: {
    backgroundColor: "rgba(11, 22, 34, 0.92)",
    borderColor: "rgba(120, 200, 255, 0.6)",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  enableText: { color: "#EAF6FF", fontSize: 15, fontWeight: "700" },
  // Camera-denied banner: sits just under the status strip, routes to Settings.
  bannerWrap: { position: "absolute", top: 0, left: 0, right: 0, alignItems: "center" },
  banner: {
    marginTop: 64, // clears the status strip; tune to taste
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(11, 22, 34, 0.9)",
    borderColor: "rgba(255, 211, 124, 0.5)",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  bannerText: { color: "#EAF6FF", fontSize: 12, fontWeight: "600" },
  // Acquiring-position hint: centred over the synthetic horizon while waiting for the first GPS fix.
  acquireWrap: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 8 },
  acquirePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(11, 22, 34, 0.9)",
    borderColor: "rgba(120, 200, 255, 0.5)",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  acquireText: { color: "#EAF6FF", fontSize: 14, fontWeight: "700" },
  acquireSub: { color: "#9FC7E0", fontSize: 12 },
});
