/**
 * vesselStore is the 5 s AIS snapshot keyed by mmsi. The behaviour that matters: setSnapshot is a
 * whole-map REPLACE (not a merge), an empty array clears, and clear() resets. Mirrors the semantics
 * useLiveFeed relies on so stale ships never linger.
 */

import { selectVesselList, useVesselStore } from "@/state/vesselStore";
import type { VesselDto } from "@/api/types";

/** Minimal positioned vessel — every field but mmsi/kind is optional on the slim DTO. */
function ship(mmsi: string, over: Partial<VesselDto> = {}): VesselDto {
  return { mmsi, kind: "ship", ...over };
}

describe("vesselStore", () => {
  beforeEach(() => {
    useVesselStore.setState({ byMmsi: {}, lastSnapshotAt: 0 });
  });

  it("keys the snapshot by mmsi", () => {
    useVesselStore.getState().setSnapshot([ship("111"), ship("222")]);
    const { byMmsi } = useVesselStore.getState();
    expect(Object.keys(byMmsi).sort()).toEqual(["111", "222"]);
    expect(byMmsi["111"].mmsi).toBe("111");
  });

  it("replaces the whole set — a later snapshot drops vessels absent from it", () => {
    const { setSnapshot } = useVesselStore.getState();
    setSnapshot([ship("111"), ship("222")]);
    setSnapshot([ship("222", { sog: 5 }), ship("333")]);
    const list = selectVesselList(useVesselStore.getState());
    expect(list.map((v) => v.mmsi).sort()).toEqual(["222", "333"]);
    // "111" is gone (replace, not merge); "222" carries the newer value.
    expect(useVesselStore.getState().byMmsi["111"]).toBeUndefined();
    expect(useVesselStore.getState().byMmsi["222"].sog).toBe(5);
  });

  it("clears on an empty snapshot", () => {
    const { setSnapshot } = useVesselStore.getState();
    setSnapshot([ship("111")]);
    setSnapshot([]);
    expect(selectVesselList(useVesselStore.getState())).toHaveLength(0);
  });

  it("clear() empties the store and resets the timestamp", () => {
    const { setSnapshot, clear } = useVesselStore.getState();
    setSnapshot([ship("111")], 1234);
    expect(useVesselStore.getState().lastSnapshotAt).toBe(1234);
    clear();
    expect(useVesselStore.getState().byMmsi).toEqual({});
    expect(useVesselStore.getState().lastSnapshotAt).toBe(0);
  });

  it("stamps lastSnapshotAt from the supplied time", () => {
    useVesselStore.getState().setSnapshot([ship("111")], 999);
    expect(useVesselStore.getState().lastSnapshotAt).toBe(999);
  });
});
