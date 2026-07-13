/**
 * Ephemeral UI selection: which satellite (if any) the Map should draw a ground track for. Set by the
 * "Show ground track" action in SatelliteDetailSheet (reached from AR + List), read by the Map screens.
 *
 * Deliberately NOT persisted — a ground track is a transient "look at this now" overlay, not a setting;
 * it should reset to nothing on a fresh launch. Cross-tab handoff only: the sheet sets the id and routes
 * to the Map tab, the Map reads it. Mirrors the tiny, single-purpose stores elsewhere (aircraft/vessel).
 */

import { create } from "zustand";

interface SatelliteTrackState {
  /** NORAD id of the satellite whose ground track the Map should draw, or null when none is selected. */
  trackedNoradId: number | null;
  /** Select a satellite to track (or null to clear the track). */
  setTracked: (id: number | null) => void;
}

export const useSatelliteTrackStore = create<SatelliteTrackState>((set) => ({
  trackedNoradId: null,
  setTracked: (id) => set({ trackedNoradId: id }),
}));
