/**
 * Polaris calibration overlay — the "point at the North Star, tap once, solve the azimuth trim" flow.
 *
 * Shown only while `polarisCalibrating` is armed (Settings → "Calibrate with Polaris"). It fills the
 * screen ABOVE the AR overlay but BELOW the status strip, and is non-interactive except its own controls
 * (pointerEvents="box-none"): a centred crosshair the user aligns with Polaris, a live az/el readout, and
 * Confirm / Cancel.
 *
 * On Confirm we read the pose ONCE and run `solveAzimuthTrim` — which is trim-aware, so the value the
 * pose reports (with the current trim already baked in) resolves to the right new trim. Polaris's
 * elevation ≈ the observer's latitude, so if the aimed elevation is far off (> tolerance) we DON'T apply
 * silently: we surface a warning with an "Apply anyway" override or an "Aim again" retry.
 *
 * The live readout polls `poseRef` on a ~4 Hz interval into state — deliberately NOT the per-frame rAF
 * path the overlay uses. The 60 Hz pose never drives a setState here.
 */

import { alpha, color, font } from "@/theme";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  POLARIS_ELEVATION_TOLERANCE_DEG,
  solveAzimuthTrim,
  type CameraPose,
  type PolarisObserver,
} from "@/ar";
import { compass8 } from "./webmap/relative";

export interface PolarisCalibrateProps {
  /** Active pose ref (live sensor or, in the no-sensor guard, whatever the screen selected). */
  poseRef: React.MutableRefObject<CameraPose>;
  /** Observer position (demo-home fallback applied by the caller); null until a live fix arrives. */
  observer: PolarisObserver | null;
  /** The trim currently baked into the pose — solveAzimuthTrim needs it to stay idempotent. */
  currentTrimDeg: number;
  /** True only when a real device/browser sensor drives the pose; false for demo/drag (guard state). */
  sensorLive: boolean;
  /** Apply the solved trim to the settings store. */
  onApplyTrim: (deg: number) => void;
  /** Leave calibrate mode (clears the armed flag). */
  onClose: () => void;
}

/** Poll interval for the live readout — 4 Hz, well off the 60 Hz rAF path. */
const READOUT_INTERVAL_MS = 250;

export function PolarisCalibrate({
  poseRef,
  observer,
  currentTrimDeg,
  sensorLive,
  onApplyTrim,
  onClose,
}: PolarisCalibrateProps) {
  // Live az/el readout, refreshed by the ~4 Hz interval below (which also seeds it immediately on mount,
  // so the ref is only ever read from inside an effect, never during render).
  const [readout, setReadout] = useState({ az: 0, el: 0 });
  // A flagged solution awaiting the user's "Apply anyway" / "Aim again" decision (null = normal state).
  const [pending, setPending] = useState<{ newTrimDeg: number; polarisElevationDeg: number } | null>(
    null,
  );

  const canCalibrate = sensorLive && !!observer;

  useEffect(() => {
    const tick = () =>
      setReadout({ az: poseRef.current.azimuth, el: poseRef.current.elevation });
    tick(); // seed immediately so the readout isn't a stale 0/0 for the first interval
    const id = setInterval(tick, READOUT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [poseRef]);

  const confirm = () => {
    if (!observer) return;
    const pose = poseRef.current; // read ONCE
    const res = solveAzimuthTrim({
      pointedAzimuthDeg: pose.azimuth,
      currentTrimDeg,
      observer,
      date: new Date(),
      pointedElevationDeg: pose.elevation,
    });
    if (
      res.elevationErrorDeg != null &&
      res.elevationErrorDeg > POLARIS_ELEVATION_TOLERANCE_DEG
    ) {
      // Elevation is nowhere near the latitude → probably not Polaris. Warn instead of applying.
      setPending({ newTrimDeg: res.newTrimDeg, polarisElevationDeg: res.polarisElevationDeg });
      return;
    }
    onApplyTrim(res.newTrimDeg);
    onClose();
  };

  const applyAnyway = () => {
    if (!pending) return;
    onApplyTrim(pending.newTrimDeg);
    onClose();
  };

  return (
    <View style={styles.root} pointerEvents="box-none">
      {/* Crosshair — pure Views, non-interactive. */}
      <View style={styles.crosshairWrap} pointerEvents="none">
        <View style={styles.crosshairBox}>
          <View style={styles.lineH} />
          <View style={styles.lineV} />
          <View style={styles.ring} />
        </View>
      </View>

      {/* Instruction + live readout, top-centre (clears the status strip). */}
      <View style={styles.topBlock} pointerEvents="none">
        <Text style={styles.instruction}>Aim the crosshair at Polaris (the North Star), then confirm</Text>
        <Text style={styles.readout}>
          {`Pointing ${Math.round(readout.az)}° ${compass8(readout.az)} · el ${Math.round(readout.el)}°`}
        </Text>
      </View>

      {/* Controls, bottom. */}
      <SafeAreaView edges={["bottom"]} style={styles.controls} pointerEvents="box-none">
        {!sensorLive ? (
          <Text style={styles.notice}>
            Calibration needs the device compass and gyro. Switch off demo mode and enable AR sensors,
            then try again.
          </Text>
        ) : !observer ? (
          <Text style={styles.notice}>Acquiring position… step outside for a clear sky, then try again.</Text>
        ) : pending ? (
          <>
            <Text style={styles.warning}>
              {`That doesn't look like Polaris — its elevation here is ~${Math.round(
                pending.polarisElevationDeg,
              )}°. Aim again.`}
            </Text>
            <View style={styles.buttonRow}>
              <Pressable
                testID="polaris-apply-anyway"
                style={[styles.button, styles.buttonSecondary]}
                onPress={applyAnyway}
                hitSlop={6}
              >
                <Text style={styles.buttonSecondaryText}>Apply anyway</Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.buttonPrimary]}
                onPress={() => setPending(null)}
                hitSlop={6}
              >
                <Text style={styles.buttonPrimaryText}>Aim again</Text>
              </Pressable>
            </View>
          </>
        ) : null}

        <View style={styles.buttonRow}>
          <Pressable
            testID="polaris-cancel"
            style={[styles.button, styles.buttonGhost]}
            onPress={onClose}
            hitSlop={6}
          >
            <Text style={styles.buttonGhostText}>Cancel</Text>
          </Pressable>
          {canCalibrate && !pending ? (
            <Pressable
              testID="polaris-confirm"
              style={[styles.button, styles.buttonPrimary]}
              onPress={confirm}
              hitSlop={6}
            >
              <Text style={styles.buttonPrimaryText}>Confirm</Text>
            </Pressable>
          ) : null}
        </View>
      </SafeAreaView>
    </View>
  );
}

const CROSSHAIR = 140;
const RING = 56;

const styles = StyleSheet.create({
  root: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 5 },
  crosshairWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  crosshairBox: { width: CROSSHAIR, height: CROSSHAIR, alignItems: "center", justifyContent: "center" },
  lineH: {
    position: "absolute",
    top: CROSSHAIR / 2 - 0.75,
    left: 0,
    width: CROSSHAIR,
    height: 1.5,
    backgroundColor: alpha(color.status.ok, 0.5),
  },
  lineV: {
    position: "absolute",
    left: CROSSHAIR / 2 - 0.75,
    top: 0,
    width: 1.5,
    height: CROSSHAIR,
    backgroundColor: alpha(color.status.ok, 0.5),
  },
  ring: {
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 2,
    borderColor: alpha(color.status.ok, 0.85),
    backgroundColor: alpha(color.status.ok, 0.08),
  },
  topBlock: { position: "absolute", top: 96, left: 24, right: 24, alignItems: "center", gap: 6 },
  instruction: {
    color: color.text,
    fontSize: font.body,
    fontWeight: "600",
    textAlign: "center",
    backgroundColor: alpha(color.bg, 0.7),
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    overflow: "hidden",
  },
  readout: {
    color: color.status.ok,
    fontSize: font.label,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  controls: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingBottom: 20,
    gap: 10,
  },
  notice: {
    color: color.status.warn,
    fontSize: font.label,
    textAlign: "center",
    backgroundColor: alpha(color.bg, 0.7),
    borderRadius: 10,
    padding: 10,
    overflow: "hidden",
  },
  warning: {
    color: color.status.error,
    fontSize: font.label,
    textAlign: "center",
    backgroundColor: alpha(color.bg, 0.7),
    borderRadius: 10,
    padding: 10,
    overflow: "hidden",
  },
  buttonRow: { flexDirection: "row", gap: 12 },
  button: { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  buttonPrimary: { backgroundColor: color.accentFill },
  buttonPrimaryText: { color: color.text, fontSize: font.control, fontWeight: "700" },
  buttonSecondary: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(color.status.warn, 0.7),
    backgroundColor: alpha(color.status.warn, 0.12),
  },
  buttonSecondaryText: { color: color.status.warn, fontSize: font.control, fontWeight: "700" },
  buttonGhost: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(color.text, 0.3),
    backgroundColor: alpha(color.bg, 0.6),
  },
  buttonGhostText: { color: color.text, fontSize: font.control, fontWeight: "600" },
});
