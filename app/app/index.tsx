/**
 * AR view — the home screen. Renders the live camera (or a static sky in demo mode)
 * with the aircraft overlay on top, a status strip, and a tap-to-open detail sheet.
 *
 * Two pose sources:
 *  - live: usePoseRefs subscribes to DeviceMotion (~60 Hz) + location/heading.
 *  - demo: useDemoPose drives the pose from a drag gesture; the mock feed replays
 *    the recorded snapshot series. This is what runs in Expo Go / on an emulator.
 *
 * The 1 Hz aircraft list lives in zustand; the 60 Hz pose lives in refs (never in
 * zustand) and is consumed by the overlay's rAF loop.
 */

import { useEffect, useMemo, useState } from "react";
import { ImageBackground, StyleSheet, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  ArOverlay,
  DetailSheet,
  StatusStrip,
  useDemoPose,
  usePoseRefs,
} from "@/components";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl } from "@/api/config";
import { startMockFeed, DEMO_HOME } from "@/mock/mockFeed";
import {
  useAircraftList,
  useAircraftStore,
} from "@/state/aircraftStore";
import { useSettingsStore } from "@/state/settingsStore";

export default function ArScreen() {
  const demoMode = useSettingsStore((s) => s.demoMode);
  const hFovDeg = useSettingsStore((s) => s.hFovDeg);
  const trimDeg = useSettingsStore((s) => s.azimuthTrimDeg);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [selectedHex, setSelectedHex] = useState<string | null>(null);

  const aircraft = useAircraftList();
  const snapshotAt = useAircraftStore((s) => s.lastSnapshotAt);
  const connection = useAircraftStore((s) => s.connection);
  const source = useAircraftStore((s) => s.source);
  const setSnapshot = useAircraftStore((s) => s.setSnapshot);
  const setSource = useAircraftStore((s) => s.setSource);
  const setConnection = useAircraftStore((s) => s.setConnection);

  const client = useMemo(() => new ApiClient({ baseUrl: getApiBaseUrl() }), []);

  // Live sensor pose (only active when not in demo mode).
  const live = usePoseRefs({ trimDeg, enabled: !demoMode });
  // Demo drag-to-look pose.
  const demo = useDemoPose({ initialAzimuth: 90 });

  const poseRef = demoMode ? demo.poseRef : live.poseRef;
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
    setSource("live");
    if (!cameraPermission?.granted) void requestCameraPermission();
  }, [demoMode, cameraPermission?.granted, requestCameraPermission, setSource]);

  const overlay = (
    <ArOverlay
      aircraft={aircraft}
      snapshotAt={snapshotAt}
      poseRef={poseRef}
      positionRef={live.positionRef}
      hFovDeg={hFovDeg}
      onSelect={setSelectedHex}
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
      ) : cameraPermission?.granted ? (
        <CameraView style={StyleSheet.absoluteFill} facing="back">
          {overlay}
        </CameraView>
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.noCam]}>{overlay}</View>
      )}

      <SafeAreaView edges={["top"]} style={styles.top} pointerEvents="box-none">
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B1622" },
  top: { position: "absolute", top: 0, left: 0, right: 0 },
  noCam: { backgroundColor: "#0B1622" },
});
