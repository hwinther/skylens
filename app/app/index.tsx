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
import { ImageBackground, Platform, StyleSheet, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  ArOverlay,
  DetailSheet,
  SatelliteDetailSheet,
  StatusStrip,
  useDemoPose,
  useObserverLocation,
  usePoseRefs,
  useSatellites,
} from "@/components";
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

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  // Selected satellite for the Phase 5 detail sheet. Captured now so the overlay's tap wiring is
  // complete; the sheet itself mounts in Phase 5 (see the placeholder near <DetailSheet/> below).
  const [selectedNoradId, setSelectedNoradId] = useState<number | null>(null);

  const baseUrl = useMemo(() => getApiBaseUrl(), []);
  // Live-mode observer: baked home coords, else a one-shot device/browser geolocation fix
  // (same source the root layout's hub subscription uses).
  const observer = useObserverLocation(!demoMode);

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

  // Live sensor pose (only active when not in demo mode).
  const live = usePoseRefs({ trimDeg, enabled: !demoMode });
  // Drag-to-look pose (demo mode, and web live — no orientation sensor there).
  const demo = useDemoPose({ initialAzimuth: 90 });

  const useDragPose = demoMode || Platform.OS === "web";
  const poseRef = useDragPose ? demo.poseRef : live.poseRef;
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
      showSatellites={showSatellites}
      poseRef={poseRef}
      positionRef={live.positionRef}
      hFovDeg={hFovDeg}
      onSelect={setSelectedHex}
      onSelectSatellite={setSelectedNoradId}
      // No camera feed (web, or native without permission) → draw a synthetic horizon.
      showHorizon={!demoMode && !cameraPermission?.granted}
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
        // Live on web: no camera preview and no compass/gyro — drag to look around the overlay.
        <GestureDetector gesture={demo.gesture}>
          <View style={[StyleSheet.absoluteFill, styles.noCam]}>{overlay}</View>
        </GestureDetector>
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

      <DetailSheet hex={selectedHex} client={client} onClose={() => setSelectedHex(null)} />
      <SatelliteDetailSheet
        noradId={selectedNoradId}
        view={selectedNoradId != null ? satHook.byNoradId.get(selectedNoradId) : undefined}
        observer={demoMode ? DEMO_HOME : observer}
        elevationMaskDeg={satElevationMaskDeg}
        onClose={() => setSelectedNoradId(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B1622" },
  top: { position: "absolute", top: 0, left: 0, right: 0, pointerEvents: "box-none" },
  noCam: { backgroundColor: "#0B1622" },
});
