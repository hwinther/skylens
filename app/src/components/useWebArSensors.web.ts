/**
 * Web-only compass/gyro pose source for mobile-browser AR.
 *
 * Subscribes to DeviceOrientation events, converts each to a back-camera CameraPose
 * (poseFromOrientation), trims + low-pass smooths it, and writes it into a ref the AR
 * overlay's rAF loop reads — mirroring native usePoseRefs, but sourced from the browser
 * sensor API. The ~60 Hz pose NEVER goes through setState; only status transitions do.
 *
 * Support gate: DeviceOrientationEvent present AND a coarse pointer (a real touch
 * device). Desktop browsers report a fine pointer → we stay "unavailable" so the home
 * screen keeps its drag-to-look behavior unchanged.
 *
 * Two platforms:
 *  - iOS Safari exposes DeviceOrientationEvent.requestPermission(): we start in
 *    "needs-permission", and request() (wired to a user-gesture button) asks for it.
 *  - Android fires events without a gate: we subscribe as soon as enabled and flip to
 *    "active" on the first valid event, or back to "unavailable" if none arrive in ~2 s.
 *
 * This file uses DOM globals, so it must stay a `.web.ts` module (Metro keeps it out of
 * the native bundle; the no-op useWebArSensors.ts is the native sibling).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  normalizeAzimuth,
  poseFromOrientation,
  smoothPose,
  type CameraPose,
  type WebOrientationSample,
} from "@/ar";

export type WebArStatus = "unavailable" | "needs-permission" | "active" | "denied";

export interface UseWebArSensorsOptions {
  /** Only attempt sensors when true (web live mode). */
  enabled: boolean;
  /** Manual azimuth trim from settings, degrees (same sign as native). */
  trimDeg: number;
}

export interface WebArSensors {
  status: WebArStatus;
  poseRef: React.MutableRefObject<CameraPose>;
  /** Ask for the sensor. On iOS this must run inside a user gesture (the Enable-AR button). */
  request(): Promise<void>;
  /** Unsubscribe from DeviceOrientation events. */
  stop(): void;
}

/** Exponential smoothing blend for the incoming pose (azimuth wraps via smoothPose). */
const SMOOTHING_ALPHA = 0.25;
/** If Android fires no valid orientation event within this window, give up (→ drag). */
const ANDROID_ACTIVATE_TIMEOUT_MS = 2000;

/** iOS 13+ only, absent from the standard lib types. */
type PermissionCapableEventStatic = {
  requestPermission?: () => Promise<"granted" | "denied" | "default">;
};

/** webkitCompassHeading is iOS-only and non-standard. */
interface WebkitDeviceOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "DeviceOrientationEvent" in window &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

/** iOS gate: returns the (bound) requestPermission fn if present, else null (Android/desktop). */
function permissionRequester(): (() => Promise<"granted" | "denied" | "default">) | null {
  if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) return null;
  const fn = (DeviceOrientationEvent as unknown as PermissionCapableEventStatic).requestPermission;
  return typeof fn === "function" ? fn.bind(DeviceOrientationEvent) : null;
}

/** Prefer the north-referenced absolute event when the browser offers it. */
function orientationEventName(): "deviceorientationabsolute" | "deviceorientation" {
  return typeof window !== "undefined" && "ondeviceorientationabsolute" in window
    ? "deviceorientationabsolute"
    : "deviceorientation";
}

/** Screen rotation in degrees (0/90/180/270). Falls back through the deprecated window.orientation. */
function readScreenAngle(): number {
  if (typeof window === "undefined") return 0;
  const so = (window.screen as { orientation?: { angle?: number } } | undefined)?.orientation;
  if (so && typeof so.angle === "number") return so.angle;
  // screen.orientation.angle is undefined on iOS < 16.4 — window.orientation is the legacy fallback.
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === "number" ? legacy : 0;
}

export function useWebArSensors({ enabled, trimDeg }: UseWebArSensorsOptions): WebArSensors {
  const poseRef = useRef<CameraPose>({ azimuth: 0, elevation: 0, roll: 0 });
  // Latest trim in a ref so the (register-once) event handler always sees the current value.
  const trimRef = useRef(trimDeg);
  useEffect(() => {
    trimRef.current = trimDeg;
  }, [trimDeg]);

  // Name of the event we subscribed to (null = not subscribed). Timeout handle for Android.
  const subscribedTo = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether a valid event has arrived this enable-cycle (drives the → active transition).
  const activatedRef = useRef(false);

  const [status, setStatus] = useState<WebArStatus>(() => {
    if (!isSupported()) return "unavailable";
    // iOS needs an explicit gesture-driven grant; Android starts "unavailable" and flips to
    // "active" on the first event (or stays unavailable if the sensor is silent → drag fallback).
    return permissionRequester() ? "needs-permission" : "unavailable";
  });

  const handleOrientation = useCallback((ev: Event) => {
    const e = ev as WebkitDeviceOrientationEvent;
    const raw = poseFromOrientation({
      alpha: e.alpha ?? NaN,
      beta: e.beta ?? NaN,
      gamma: e.gamma ?? NaN,
      absolute: e.absolute === true,
      webkitCompassHeading: e.webkitCompassHeading,
      screenAngle: readScreenAngle(),
    } satisfies WebOrientationSample);
    if (!raw) return; // ignore null-ish samples

    const trimmed: CameraPose = {
      ...raw,
      azimuth: normalizeAzimuth(raw.azimuth + trimRef.current),
    };
    poseRef.current = smoothPose(poseRef.current, trimmed, SMOOTHING_ALPHA);

    if (!activatedRef.current) {
      activatedRef.current = true;
      if (timeoutRef.current != null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setStatus("active");
    }
  }, []);

  const subscribe = useCallback(() => {
    if (subscribedTo.current) return;
    const name = orientationEventName();
    window.addEventListener(name, handleOrientation);
    subscribedTo.current = name;
  }, [handleOrientation]);

  const unsubscribe = useCallback(() => {
    if (!subscribedTo.current) return;
    window.removeEventListener(subscribedTo.current, handleOrientation);
    subscribedTo.current = null;
  }, [handleOrientation]);

  const stop = useCallback(() => {
    unsubscribe();
    if (timeoutRef.current != null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, [unsubscribe]);

  const request = useCallback(async () => {
    if (!isSupported()) {
      setStatus("unavailable");
      return;
    }
    const rp = permissionRequester();
    if (!rp) {
      // Android has no permission gate — just subscribe (used if the button ever shows).
      subscribe();
      return;
    }
    // NOTE: rp() is invoked synchronously before the first await so it stays inside the
    // user-gesture stack iOS requires.
    try {
      const result = await rp();
      if (result === "granted") {
        activatedRef.current = true;
        subscribe();
        setStatus("active");
      } else {
        setStatus("denied");
      }
    } catch {
      setStatus("denied");
    }
  }, [subscribe]);

  // Android auto-subscribe + activation timeout. iOS waits for request(); the cleanup below
  // still tears down the request()-created subscription when enabled flips false / on unmount.
  useEffect(() => {
    if (!enabled || !isSupported()) return;
    activatedRef.current = false;
    if (!permissionRequester()) {
      subscribe();
      timeoutRef.current = setTimeout(() => {
        if (!activatedRef.current) {
          unsubscribe();
          setStatus("unavailable");
        }
      }, ANDROID_ACTIVATE_TIMEOUT_MS);
    }
    return () => {
      unsubscribe();
      if (timeoutRef.current != null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [enabled, subscribe, unsubscribe]);

  return { status, poseRef, request, stop };
}
