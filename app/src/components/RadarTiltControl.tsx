/**
 * The Radar's tilt control: a small vertical track at the scope's top-left (the zoom control owns the
 * top-right). Drag it up to tilt the scope into an oblique relief view, down to flatten it; a tap toggles
 * flat <-> the last tilt (45° the first time). A gesture-handler Pan + Tap (the app's gesture system, the
 * same one as AR drag-to-look): mouse on web and touch on Android, and it only claims touches that start
 * on the control, so blip taps are untouched.
 *
 * While dragging, the scope re-renders at most once per animation frame and only on whole-degree changes
 * (`onLive`); the persisted setting is written once, on release (`onCommit`).
 */

import { alpha, color } from "@/theme";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View, type AccessibilityActionEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-worklets";
import { MAX_TILT_DEG, clampTilt } from "@/radar/projection";

export interface RadarTiltControlProps {
  tiltDeg: number;
  /** Live value while dragging (throttled to animation frames, whole degrees). */
  onLive: (deg: number) => void;
  /** Final value: drag release, tap toggle or an accessibility step. */
  onCommit: (deg: number) => void;
}

/** Gesture test ids, for gesture-handler's jest utilities. */
export const TILT_PAN_GESTURE_ID = "radar-tilt-pan";
export const TILT_TAP_GESTURE_ID = "radar-tilt-tap";

const TRACK_H = 84;
const THUMB = 14;
/** Tilt a tap switches to from flat, before the user has picked one. */
const DEFAULT_TILT = 45;
const STEP = 15;
/** Movement (px) that turns a press into a drag. */
const TAP_SLOP = 4;
/** Degrees per px of vertical drag: the thumb follows the finger along the track. */
export const TILT_DEG_PER_PX = MAX_TILT_DEG / (TRACK_H - THUMB);

/**
 * The drag state and the latest props, outside React state: the gesture callbacks run between renders,
 * and the gesture itself is built once per mount so a live tilt update never rebuilds it mid-drag.
 */
function createTiltController() {
  let tilt = 0;
  let lastTilt = DEFAULT_TILT;
  let onLive: (deg: number) => void = () => {};
  let onCommit: (deg: number) => void = () => {};
  let start = 0;
  let latest = 0;
  let frame: number | null = null;
  const flush = () => {
    frame = null;
    onLive(latest);
  };
  return {
    sync(next: RadarTiltControlProps) {
      tilt = next.tiltDeg;
      if (tilt > 0) lastTilt = tilt;
      onLive = next.onLive;
      onCommit = next.onCommit;
    },
    begin() {
      start = tilt;
      latest = tilt;
    },
    update(dy: number) {
      const next = clampTilt(start - dy * TILT_DEG_PER_PX);
      if (next === latest) return;
      latest = next;
      if (frame == null) frame = requestAnimationFrame(flush);
    },
    end() {
      if (frame != null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      onCommit(latest);
    },
    toggle() {
      onCommit(tilt > 0 ? 0 : lastTilt);
    },
  };
}

export function RadarTiltControl({ tiltDeg, onLive, onCommit }: RadarTiltControlProps) {
  const [ctl] = useState(createTiltController);
  useEffect(() => {
    ctl.sync({ tiltDeg, onLive, onCommit });
  }, [ctl, tiltDeg, onLive, onCommit]);

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .minDistance(TAP_SLOP)
      .withTestId(TILT_PAN_GESTURE_ID)
      .onStart(() => {
        runOnJS(ctl.begin)();
      })
      .onUpdate((e) => {
        runOnJS(ctl.update)(e.translationY);
      })
      .onEnd(() => {
        runOnJS(ctl.end)();
      });
    const tap = Gesture.Tap()
      .maxDistance(TAP_SLOP)
      .withTestId(TILT_TAP_GESTURE_ID)
      .onEnd((_e, success) => {
        if (success) runOnJS(ctl.toggle)();
      });
    return Gesture.Race(pan, tap);
  }, [ctl]);

  const onAction = (e: AccessibilityActionEvent) => {
    const now = tiltDeg;
    if (e.nativeEvent.actionName === "increment") onCommit(clampTilt(now + STEP));
    else if (e.nativeEvent.actionName === "decrement") onCommit(clampTilt(now - STEP));
    else if (e.nativeEvent.actionName === "activate") onCommit(now > 0 ? 0 : DEFAULT_TILT);
  };

  const thumbTop = (1 - tiltDeg / MAX_TILT_DEG) * (TRACK_H - THUMB);
  return (
    <GestureDetector gesture={gesture}>
      <View
        testID="radar-tilt"
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Radar tilt"
        accessibilityHint="Drag up to tilt the radar into a relief view, down to flatten it. Tap to toggle."
        accessibilityValue={{
          min: 0,
          max: MAX_TILT_DEG,
          now: tiltDeg,
          text: `${tiltDeg} degrees`,
        }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }, { name: "activate" }]}
        onAccessibilityAction={onAction}
        hitSlop={6}
        style={styles.root}
      >
        <Text style={styles.label}>TILT</Text>
        <View style={styles.track}>
          <View style={styles.rail} />
          <View style={[styles.fill, { top: thumbTop + THUMB / 2 }]} />
          <View style={[styles.thumb, tiltDeg > 0 && styles.thumbOn, { top: thumbTop }]} />
        </View>
        <Text testID="radar-tilt-value" style={styles.value}>
          {tiltDeg}°
        </Text>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    top: 4,
    left: 4,
    width: 34,
    alignItems: "center",
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(color.entity.air, 0.35),
    backgroundColor: "rgba(18, 40, 61, 0.55)",
    gap: 4,
  },
  label: {
    color: alpha(color.textDim, 0.95),
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.5,
    pointerEvents: "none",
  },
  value: {
    color: alpha(color.text, 0.9),
    fontSize: 11,
    fontWeight: "600",
    pointerEvents: "none",
  },
  track: {
    width: THUMB,
    height: TRACK_H,
    alignItems: "center",
    pointerEvents: "none",
  },
  rail: {
    position: "absolute",
    width: 2,
    top: THUMB / 2,
    bottom: THUMB / 2,
    borderRadius: 1,
    backgroundColor: alpha(color.entity.air, 0.2),
  },
  fill: {
    position: "absolute",
    width: 2,
    bottom: THUMB / 2,
    borderRadius: 1,
    backgroundColor: alpha(color.entity.air, 0.6),
  },
  thumb: {
    position: "absolute",
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 1.5,
    borderColor: alpha(color.entity.air, 0.9),
    backgroundColor: color.bg,
  },
  thumbOn: { backgroundColor: alpha(color.entity.air, 0.85) },
});
