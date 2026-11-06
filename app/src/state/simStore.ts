/**
 * Simulator session: which object the cockpit view follows, and (for aircraft/vessels) where it is
 * now. Like mapFocusStore it is ephemeral UI state, never persisted.
 *
 * While `centre` is set, the root layout re-centres the live hub subscription on the followed object
 * (SIM_RADIUS_KM) instead of the observer, so it stays in the feed after leaving the observer's radius.
 * That reuses the hub's own-feed / away-mode path with its cell cache and budgets: no new upstream calls.
 */

import { create } from "zustand";
import type { SimKind } from "@/sim/simPose";

/** Subscription radius around the followed object. */
export const SIM_RADIUS_KM = 50;

/** The subscription centre moves in steps of this many degrees (~5 km), so it isn't re-sent every tick. */
const CENTRE_STEP_DEG = 0.05;

export interface SimTarget {
  kind: SimKind;
  /** Aircraft hex, vessel MMSI or NORAD id (as a string). */
  id: string;
}

interface SimState {
  target: SimTarget | null;
  /** Rounded subscription centre, or null to use the observer. */
  centre: { lat: number; lon: number } | null;
  start: (target: SimTarget) => void;
  /** Report the followed object's position; only a move to a new grid step updates the store. */
  setPosition: (lat: number, lon: number) => void;
  stop: () => void;
}

const snap = (v: number) => Math.round(v / CENTRE_STEP_DEG) * CENTRE_STEP_DEG;

export const useSimStore = create<SimState>((set, get) => ({
  target: null,
  centre: null,
  start: (target) => set({ target, centre: null }),
  setPosition: (lat, lon) => {
    const { target, centre } = get();
    if (!target || target.kind === "satellite") return;
    const next = { lat: snap(lat), lon: snap(lon) };
    if (centre && centre.lat === next.lat && centre.lon === next.lon) return;
    set({ centre: next });
  },
  stop: () => set({ target: null, centre: null }),
}));
