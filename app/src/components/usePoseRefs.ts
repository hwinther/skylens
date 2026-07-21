/**
 * Sensor + location plumbing for the AR view.
 *
 * Critical performance rule (from the plan): the 60 Hz device pose NEVER goes
 * through zustand. DeviceMotion fires ~60 Hz; we write the smoothed camera pose into
 * a mutable ref that the rAF overlay loop reads. Location and heading update slowly
 * (2 s / on change) and can afford setState, but we still stash them in refs so the
 * per-frame projection reads everything from refs without re-rendering.
 *
 * In demo mode the caller drives `poseRef` via drag-to-look instead, so this hook is
 * only wired up for the live path.
 */

import { useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import { DeviceMotion } from "expo-sensors";
import * as Location from "expo-location";
import {
  cameraPoseFromRotation,
  smoothPose,
  type CameraPose,
  type GeoPoint,
} from "@/ar";

export interface PoseRefs {
  /** Latest smoothed back-camera pose (true north). */
  poseRef: React.MutableRefObject<CameraPose>;
  /** Latest observer position (GPS). null until first fix. */
  positionRef: React.MutableRefObject<GeoPoint | null>;
  /** Magnetic declination = trueHeading − magHeading, degrees. */
  declinationRef: React.MutableRefObject<number>;
  /** Heading accuracy bucket from watchHeadingAsync (0 worst … 3 best). */
  headingAccuracyRef: React.MutableRefObject<number>;
  /** GPS accuracy in metres (horizontal), or null. */
  gpsAccuracyRef: React.MutableRefObject<number | null>;
  /** Inject an observer position (used by demo mode instead of GPS). */
  setObserverPosition: (position: GeoPoint) => void;
}

export interface UsePoseRefsOptions {
  /** Manual azimuth trim from settings, degrees. */
  trimDeg: number;
  /** Low-pass smoothing factor at ~60 Hz. */
  alpha?: number;
  /** Disable sensor subscriptions (demo mode drives the pose externally). */
  enabled: boolean;
}

export function usePoseRefs(options: UsePoseRefsOptions): PoseRefs {
  const { trimDeg, alpha = 0.15, enabled } = options;

  const poseRef = useRef<CameraPose>({ azimuth: 0, elevation: 0, roll: 0 });
  const positionRef = useRef<GeoPoint | null>(null);
  const declinationRef = useRef<number>(0);
  const headingAccuracyRef = useRef<number>(0);
  const gpsAccuracyRef = useRef<number | null>(null);

  // Keep the latest trim in a ref so the motion callback (registered once) sees it.
  const trimRef = useRef(trimDeg);
  useEffect(() => {
    trimRef.current = trimDeg;
  }, [trimDeg]);

  useEffect(() => {
    if (!enabled) return;
    let motionSub: { remove: () => void } | undefined;
    let positionSub: Location.LocationSubscription | undefined;
    let headingSub: Location.LocationSubscription | undefined;
    let cancelled = false;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;

      // DeviceMotion (orientation) has no web implementation — calling addListener there throws.
      // Skip it on web so the overlay falls back to a fixed north-facing pose instead of crashing;
      // native is unchanged.
      if (Platform.OS !== "web") {
        DeviceMotion.setUpdateInterval(16); // ~60 Hz
        motionSub = DeviceMotion.addListener((data) => {
          if (!data.rotation) return;
          // data.orientation is the OS-applied screen rotation (0 / 90 / 180 / −90, from
          // Surface.getRotation on Android). The pose wants its NEGATION: Android reports the
          // rotation of the drawn graphics, which is the opposite of the physical device turn,
          // so negating it makes a landscape hold read level (roll ≈ 0) once the UI + camera
          // preview have rotated with the device. See orientation.poseFromMatrix.
          const screenAngleDeg = -(data.orientation ?? 0);
          const next = cameraPoseFromRotation(
            {
              alpha: data.rotation.alpha,
              beta: data.rotation.beta,
              gamma: data.rotation.gamma,
            },
            declinationRef.current,
            trimRef.current,
            screenAngleDeg,
          );
          poseRef.current = smoothPose(poseRef.current, next, alpha);
        });
      }

      if (status === "granted") {
        // GPS works on web via the browser Geolocation API (secure context, incl. localhost).
        positionSub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 2000, distanceInterval: 5 },
          (loc) => {
            positionRef.current = {
              lat: loc.coords.latitude,
              lon: loc.coords.longitude,
              alt: loc.coords.altitude ?? 0,
            };
            gpsAccuracyRef.current = loc.coords.accuracy ?? null;
          },
        );

        // Compass heading is a native magnetometer feature; browsers have no equivalent.
        if (Platform.OS !== "web") {
          headingSub = await Location.watchHeadingAsync((heading) => {
            // declination = trueHeading − magHeading (Android computes WMM true north).
            declinationRef.current = heading.trueHeading - heading.magHeading;
            headingAccuracyRef.current = heading.accuracy ?? 0;
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      motionSub?.remove();
      positionSub?.remove();
      headingSub?.remove();
    };
  }, [enabled, alpha]);

  const setObserverPosition = useCallback((position: GeoPoint) => {
    positionRef.current = position;
  }, []);

  return {
    poseRef,
    positionRef,
    declinationRef,
    headingAccuracyRef,
    gpsAccuracyRef,
    setObserverPosition,
  };
}
