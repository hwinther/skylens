/**
 * The cockpit window frame's state for one screen (shared by the web and Android cockpit screens): which
 * frame the followed object gets (src/sim/cockpitFrame.ts frameVariant: aeroplane / helicopter from the
 * aircraft's type or category, bridge for a vessel, none for a satellite), the persisted on/off setting
 * (settingsStore.simCockpitFrame, on by default) and whether the toggle applies at all. The aircraft is
 * read from the live store, so "Follow this" (a new target) and a type that arrives later both update it.
 *
 * The frame only belongs in the cockpit camera: in the outside (chase) view, and for satellites, the
 * toggle is hidden rather than shown disabled (it would do nothing there). The screens also wait for the
 * globe to be ready before drawing it.
 */

import { useAircraftStore } from "@/state/aircraftStore";
import { useSettingsStore } from "@/state/settingsStore";
import type { SimTarget } from "@/state/simStore";
import type { CameraMode } from "@/sim/chase";
import { frameVariant, type CockpitFrameVariant } from "@/sim/cockpitFrame";

export interface CockpitFrameState {
  /** The followed object's frame, or null (a satellite, no target). */
  variant: CockpitFrameVariant | null;
  /** The persisted choice. */
  enabled: boolean;
  /** Whether the "Frame" toggle applies (a framed object in the cockpit camera). */
  toggleShown: boolean;
  /** Toggle shown and switched on: draw the frame (once the globe is ready). */
  shown: boolean;
  toggle: () => void;
}

export function useCockpitFrame(target: SimTarget | null, cameraMode: CameraMode): CockpitFrameState {
  // A primitive per render, so other aircraft moving never re-renders the screen for this.
  const variant = useAircraftStore((s) =>
    target ? frameVariant(target.kind, target.kind === "aircraft" ? s.byHex[target.id] : null) : null,
  );
  const enabled = useSettingsStore((s) => s.simCockpitFrame);
  const setEnabled = useSettingsStore((s) => s.setSimCockpitFrame);
  const toggleShown = variant != null && cameraMode === "cockpit";
  return {
    variant,
    enabled,
    toggleShown,
    shown: toggleShown && enabled,
    toggle: () => setEnabled(!useSettingsStore.getState().simCockpitFrame),
  };
}
