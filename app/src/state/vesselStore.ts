/**
 * The 5 s AIS vessel list. Mirrors aircraftStore, minus the connection state: vessels ride the
 * SAME /hubs/aircraft connection as aircraft (see useLiveFeed), so the shared connection/source
 * lives in aircraftStore and this store is only the keyed snapshot. Writing here once every 5 s is
 * cheap; the AR camera pose never touches it (same discipline as aircraftStore).
 */

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { VesselDto } from "@/api/types";

interface VesselState {
  /** Latest snapshot, keyed by mmsi for O(1) merge/lookup. */
  byMmsi: Record<string, VesselDto>;
  /** Epoch ms the last snapshot was received. */
  lastSnapshotAt: number;
  /** Replace the whole set from a fresh 5 s snapshot; an empty array clears all ships. */
  setSnapshot: (vessels: VesselDto[], at?: number) => void;
  clear: () => void;
}

export const useVesselStore = create<VesselState>((set) => ({
  byMmsi: {},
  lastSnapshotAt: 0,
  setSnapshot: (vessels, at = Date.now()) =>
    set(() => {
      const byMmsi: Record<string, VesselDto> = {};
      for (const v of vessels) byMmsi[v.mmsi] = v;
      return { byMmsi, lastSnapshotAt: at };
    }),
  clear: () => set({ byMmsi: {}, lastSnapshotAt: 0 }),
}));

/**
 * Selector: the current vessels as an array. Like selectAircraftList this allocates a fresh array
 * on every call, so it is NOT a stable snapshot — feed it through useVesselList(), which
 * shallow-compares, rather than straight into useVesselStore (React would loop on "getSnapshot
 * should be cached").
 */
export function selectVesselList(state: VesselState): VesselDto[] {
  return Object.values(state.byMmsi);
}

/**
 * Subscribe to the vessel list with a stable reference. useShallow reuses the previous array when
 * nothing changed, so an unrelated aircraft-store update never re-renders the ships; a fresh 5 s
 * snapshot swaps in new DTOs and does update.
 */
export function useVesselList(): VesselDto[] {
  return useVesselStore(useShallow(selectVesselList));
}
