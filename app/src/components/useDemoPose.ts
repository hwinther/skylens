/**
 * Demo-mode pose: instead of real sensors, the operator drags on the screen to look
 * around. A pan gesture adjusts camera azimuth (horizontal drag) and elevation
 * (vertical drag), writing into the same poseRef the overlay reads. This lets the
 * whole AR pipeline be exercised on an emulator / Expo Go with no compass or GPS.
 */

import { useMemo, useRef } from "react";
import { Gesture } from "react-native-gesture-handler";
import { runOnJS } from "react-native-worklets";
import { normalizeAzimuth, type CameraPose } from "@/ar";

export interface UseDemoPoseResult {
  poseRef: React.MutableRefObject<CameraPose>;
  gesture: ReturnType<typeof Gesture.Pan>;
}

export interface UseDemoPoseOptions {
  /** Degrees of look change per screen pixel dragged. */
  degPerPx?: number;
  /** Initial azimuth to face. */
  initialAzimuth?: number;
}

export function useDemoPose(options: UseDemoPoseOptions = {}): UseDemoPoseResult {
  const { degPerPx = 0.15, initialAzimuth = 0 } = options;
  const initialPose: CameraPose = { azimuth: initialAzimuth, elevation: 20, roll: 0 };
  const poseRef = useRef<CameraPose>(initialPose);
  const startRef = useRef<CameraPose>(initialPose);

  const apply = (dxDeg: number, dyDeg: number) => {
    const az = normalizeAzimuth(startRef.current.azimuth + dxDeg);
    const el = clamp(startRef.current.elevation - dyDeg, -20, 90);
    poseRef.current = { azimuth: az, elevation: el, roll: 0 };
  };

  const begin = () => {
    startRef.current = poseRef.current;
  };

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .onBegin(() => {
          runOnJS(begin)();
        })
        .onUpdate((e) => {
          runOnJS(apply)(e.translationX * degPerPx, e.translationY * degPerPx);
        }),
    [degPerPx],
  );

  return { poseRef, gesture };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
