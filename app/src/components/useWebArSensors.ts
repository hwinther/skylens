/**
 * Native (and default) no-op sibling of useWebArSensors.web.ts.
 *
 * The web build gets real compass/gyro AR via DeviceOrientation events; native already
 * has usePoseRefs (DeviceMotion + magnetometer), so this variant never activates. It
 * exists purely so app/index.tsx can call the hook unconditionally without any DOM
 * globals reaching the native (Hermes) bundle — same platform-split discipline as
 * WebCameraView / MapScreen. Keep the exported types identical to the .web.ts version.
 */

import { useRef } from "react";
import type { CameraPose } from "@/ar";

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
  /** Request sensor (and, on iOS, permission) — no-op on native. */
  request(): Promise<void>;
  /** Tear down any subscription — no-op on native. */
  stop(): void;
}

export function useWebArSensors(_options: UseWebArSensorsOptions): WebArSensors {
  const poseRef = useRef<CameraPose>({ azimuth: 0, elevation: 0, roll: 0 });
  return {
    status: "unavailable",
    poseRef,
    request: async () => {},
    stop: () => {},
  };
}
