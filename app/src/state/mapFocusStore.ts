/**
 * Ephemeral UI selection: which aircraft or vessel (if any) the Map should centre on and follow. Set by
 * the "Show on map" action in DetailSheet / VesselDetailSheet (reached from List, AR and the Map
 * itself), read by the Map screens. Same cross-tab handoff as satelliteTrackStore, and likewise NOT
 * persisted: it is a "look at this now" request, not a setting.
 *
 * `seq` increments on every setFocus, so asking for the same target again (e.g. after panning away)
 * still re-centres the map. `following` is true while the map keeps the target centred; a user pan
 * turns it off, and tapping the focus chip turns it back on.
 */

import { create } from "zustand";

export type MapFocus = { kind: "aircraft"; hex: string } | { kind: "vessel"; mmsi: string };

interface MapFocusState {
  focus: MapFocus | null;
  /** Bumped on each setFocus; the Map re-centres whenever it changes. */
  seq: number;
  /** Keep the target centred as it moves. */
  following: boolean;
  /** Focus a target (and start following it). */
  setFocus: (focus: MapFocus) => void;
  /** Stop or resume following without dropping the focus. */
  setFollowing: (following: boolean) => void;
  /** Drop the focus entirely. */
  clear: () => void;
}

export const useMapFocusStore = create<MapFocusState>((set) => ({
  focus: null,
  seq: 0,
  following: false,
  setFocus: (focus) => set((s) => ({ focus, seq: s.seq + 1, following: true })),
  setFollowing: (following) => set({ following }),
  clear: () => set({ focus: null, following: false }),
}));
