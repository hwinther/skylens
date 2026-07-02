/**
 * The 1 Hz aircraft list + live-connection status. This is the ONLY per-aircraft
 * state that flows through zustand — the 60 Hz camera pose stays in refs inside the
 * AR view and never triggers a store update (see ArView). Writing here once a second
 * is cheap; writing here 60×/s would thrash React.
 */

import { create } from "zustand";
import type { AircraftDto } from "@/api/types";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

/** Where the currently displayed aircraft came from. */
export type FeedSource = "live" | "demo";

interface AircraftState {
  /** Latest snapshot, keyed by hex for O(1) merge/lookup. */
  byHex: Record<string, AircraftDto>;
  /** Epoch ms the last snapshot was received. */
  lastSnapshotAt: number;
  connection: ConnectionState;
  source: FeedSource;
  /** Replace the whole set from a fresh 1 Hz snapshot. */
  setSnapshot: (aircraft: AircraftDto[], at?: number) => void;
  setConnection: (connection: ConnectionState) => void;
  setSource: (source: FeedSource) => void;
  clear: () => void;
}

export const useAircraftStore = create<AircraftState>((set) => ({
  byHex: {},
  lastSnapshotAt: 0,
  connection: "disconnected",
  source: "demo",
  setSnapshot: (aircraft, at = Date.now()) =>
    set(() => {
      const byHex: Record<string, AircraftDto> = {};
      for (const ac of aircraft) byHex[ac.hex] = ac;
      return { byHex, lastSnapshotAt: at };
    }),
  setConnection: (connection) => set({ connection }),
  setSource: (source) => set({ source }),
  clear: () => set({ byHex: {}, lastSnapshotAt: 0 }),
}));

/** Selector: the current aircraft as an array (memo at the call site if needed). */
export function selectAircraftList(state: AircraftState): AircraftDto[] {
  return Object.values(state.byHex);
}
