/**
 * The cockpit HUD's text, shared by the web and Android screens. Pure (no React), so jest runs it.
 */

import { KNOTS_TO_MPS } from "@/ar/smoothing";
import { FEET_TO_M, type SimKind } from "./simPose";
import type { TrackedPose } from "./tracker";

/** The status line under the HUD rows: error first, then the data's freshness, then the 3D engine. */
export function statusText(pose: TrackedPose | null, engineReady: boolean, error: string | null): string {
  if (error) return error;
  if (!pose) return "Waiting for position…";
  if (pose.stale) return "Signal lost — holding last position";
  if (!engineReady) return "Loading 3D view…";
  if (pose.ageS < 3) return "Live";
  // A vessel's data can be minutes old before it counts as lost.
  return pose.ageS < 90 ? `Data ${Math.round(pose.ageS)} s old` : `Data ${Math.round(pose.ageS / 60)} min old`;
}

/** One HUD row: label, value, testID. */
export type HudRow = readonly [label: string, value: string, testID: string];

/** The HUD rows per object kind (altitude in feet for aircraft, km for satellites; none for vessels). */
export function hudRows(kind: SimKind, pose: TrackedPose): HudRow[] {
  const heading = `${Math.round(pose.headingDeg) % 360}°`;
  const knots = `${Math.round(pose.speedMps / KNOTS_TO_MPS)} kt`;
  if (kind === "satellite") {
    return [
      ["ALT", `${Math.round(pose.altM / 1000)} km`, "sim-alt"],
      ["SPD", `${(pose.speedMps / 1000).toFixed(2)} km/s`, "sim-speed"],
      ["HDG", heading, "sim-heading"],
    ];
  }
  if (kind === "vessel") {
    return [
      ["SPD", knots, "sim-speed"],
      ["HDG", heading, "sim-heading"],
    ];
  }
  return [
    ["ALT", `${Math.round(pose.altM / FEET_TO_M / 10) * 10} ft`, "sim-alt"],
    ["SPD", knots, "sim-speed"],
    ["HDG", heading, "sim-heading"],
    ["PITCH", `${pose.pitchDeg.toFixed(1)}°`, "sim-pitch"],
  ];
}
