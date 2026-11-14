/**
 * The Radar's view rotation: a horizontal drag anywhere on the scope turns it around the observer (who
 * stays at the centre; there is no panning). A gesture-handler Pan — the app's gesture system, like the
 * tilt control and AR drag-to-look — so it is the same for the mouse on web and touch on Android.
 *
 * - It activates only after 10 px of horizontal movement, so a tap (or a pinch) never turns the scope and
 *   blip taps keep working; the tilt control's own Pan activates sooner (4 px) and wins on the control.
 * - While dragging, the bearing updates at most once per animation frame, in whole degrees.
 * - A drag that started on a blip must not open its card on release: `suppressPress()` is true during a
 *   rotation drag and briefly after it, and the blips' onPress checks it (gesture-handler cancels the JS
 *   responder on Android, but on web the Pressable would still see the release).
 *
 * Session state: the bearing is not persisted. Leaving the Radar view (or the app) brings it back north up.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Gesture } from "react-native-gesture-handler";
import { runOnJS } from "react-native-worklets";
import { dragBearing } from "@/radar/rotation";

/** Gesture test id, for gesture-handler's jest utilities. */
export const ROTATE_PAN_GESTURE_ID = "radar-rotate-pan";

/** Horizontal movement (px) before a press on the scope becomes a rotation drag. */
const ACTIVE_OFFSET_PX = 10;
/** A release this soon after a rotation drag is not a tap. */
const PRESS_SUPPRESS_MS = 200;

function createRotationController() {
  let bearing = 0;
  let radiusPx = 1;
  let onLive: (deg: number) => void = () => {};
  let start = 0;
  let latest = 0;
  let frame: number | null = null;
  let dragging = false;
  let endedAt = Number.NEGATIVE_INFINITY;
  const flush = () => {
    frame = null;
    onLive(latest);
  };
  return {
    sync(next: { bearing: number; radiusPx: number; onLive: (deg: number) => void }) {
      bearing = next.bearing;
      radiusPx = next.radiusPx;
      onLive = next.onLive;
    },
    begin() {
      start = bearing;
      latest = bearing;
      dragging = true;
    },
    update(dx: number) {
      const next = dragBearing(start, dx, radiusPx);
      if (next === latest) return;
      latest = next;
      if (frame == null) frame = requestAnimationFrame(flush);
    },
    end() {
      if (frame != null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      if (!dragging) return;
      dragging = false;
      endedAt = Date.now();
      onLive(latest);
    },
    suppressPress() {
      return dragging || Date.now() - endedAt < PRESS_SUPPRESS_MS;
    },
  };
}

export interface RadarRotation {
  /** View bearing: the true bearing up the screen, whole degrees in [0, 360). */
  bearing: number;
  /** The scope's drag-to-rotate gesture. */
  gesture: ReturnType<typeof Gesture.Pan>;
  /** Back to north up. */
  northUp: () => void;
  /** True while (and just after) a rotation drag: a blip press then is not a tap. */
  suppressPress: () => boolean;
}

/** `radiusPx`: the scope's outer-ring radius, so the far rim follows the finger. */
export function useRadarRotation(radiusPx: number, enabled = true): RadarRotation {
  const [bearing, setBearing] = useState(0);
  const [ctl] = useState(createRotationController);
  useEffect(() => {
    ctl.sync({ bearing, radiusPx, onLive: setBearing });
  }, [ctl, bearing, radiusPx]);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .activeOffsetX([-ACTIVE_OFFSET_PX, ACTIVE_OFFSET_PX])
        .withTestId(ROTATE_PAN_GESTURE_ID)
        .onStart(() => {
          runOnJS(ctl.begin)();
        })
        .onUpdate((e) => {
          runOnJS(ctl.update)(e.translationX);
        })
        .onEnd(() => {
          runOnJS(ctl.end)();
        }),
    [ctl, enabled],
  );

  const northUp = useCallback(() => setBearing(0), []);
  return {
    bearing: enabled ? bearing : 0,
    gesture,
    northUp,
    suppressPress: ctl.suppressPress,
  };
}
