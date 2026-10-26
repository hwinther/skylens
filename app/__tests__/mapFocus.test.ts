/**
 * "Show on map" handoff: mapFocusStore (seq bumps on every request so a repeat re-centres; following
 * starts on, can be paused, and clear drops it) and resolveFocus (live position lookup, label
 * fallbacks, and a "signal lost" target when the entity has left the feed).
 */

import { useMapFocusStore } from "@/state/mapFocusStore";
import { FOCUS_SPAN_DEG, FOCUS_ZOOM, resolveFocus } from "@/components/webmap/focus";
import type { AircraftDto, VesselDto } from "@/api/types";

const ac = (hex: string, over: Partial<AircraftDto> = {}): AircraftDto =>
  ({ hex, src: "adsb", ...over }) as AircraftDto;
const ship = (mmsi: string, over: Partial<VesselDto> = {}): VesselDto => ({ mmsi, kind: "ship", ...over });

describe("mapFocusStore", () => {
  beforeEach(() => {
    useMapFocusStore.setState({ focus: null, seq: 0, following: false });
  });

  it("setFocus stores the target, bumps seq and starts following", () => {
    useMapFocusStore.getState().setFocus({ kind: "aircraft", hex: "4ac9e1" });
    const s = useMapFocusStore.getState();
    expect(s.focus).toEqual({ kind: "aircraft", hex: "4ac9e1" });
    expect(s.seq).toBe(1);
    expect(s.following).toBe(true);
  });

  it("re-requesting the same target bumps seq again (so the map re-centres)", () => {
    const { setFocus } = useMapFocusStore.getState();
    setFocus({ kind: "vessel", mmsi: "257011940" });
    useMapFocusStore.getState().setFollowing(false);
    setFocus({ kind: "vessel", mmsi: "257011940" });
    const s = useMapFocusStore.getState();
    expect(s.seq).toBe(2);
    expect(s.following).toBe(true);
  });

  it("setFollowing pauses without dropping the focus; clear drops it", () => {
    const store = useMapFocusStore.getState();
    store.setFocus({ kind: "aircraft", hex: "abc123" });
    store.setFollowing(false);
    expect(useMapFocusStore.getState().focus).not.toBeNull();
    expect(useMapFocusStore.getState().following).toBe(false);

    store.clear();
    expect(useMapFocusStore.getState().focus).toBeNull();
    expect(useMapFocusStore.getState().following).toBe(false);
  });
});

describe("resolveFocus", () => {
  it("returns null without a focus", () => {
    expect(resolveFocus(null, [ac("a1", { lat: 60, lon: 5 })], [])).toBeNull();
  });

  it("resolves an aircraft to its live position and trimmed callsign", () => {
    const t = resolveFocus(
      { kind: "aircraft", hex: "4ac9e1" },
      [ac("111111", { lat: 59, lon: 10 }), ac("4ac9e1", { flight: "SAS4123 ", lat: 60.42, lon: 5.25 })],
      [],
    );
    expect(t).toEqual({ kind: "aircraft", id: "4ac9e1", label: "SAS4123", position: { lat: 60.42, lon: 5.25 } });
  });

  it("falls back to the upper-cased hex when there is no callsign", () => {
    const t = resolveFocus({ kind: "aircraft", hex: "4ac9e1" }, [ac("4ac9e1", { lat: 1, lon: 2 })], []);
    expect(t?.label).toBe("4AC9E1");
  });

  it("resolves a vessel by mmsi with its name", () => {
    const t = resolveFocus(
      { kind: "vessel", mmsi: "257011940" },
      [],
      [ship("257011940", { name: "BALDER", lat: 69.54, lon: 17.77 })],
    );
    expect(t).toEqual({ kind: "vessel", id: "257011940", label: "BALDER", position: { lat: 69.54, lon: 17.77 } });
  });

  it("keeps the target with a null position once it leaves the feed (signal lost)", () => {
    expect(resolveFocus({ kind: "vessel", mmsi: "257011940" }, [], [])).toEqual({
      kind: "vessel",
      id: "257011940",
      label: "257011940",
      position: null,
    });
  });

  it("treats a present but unpositioned aircraft as signal lost", () => {
    const t = resolveFocus({ kind: "aircraft", hex: "a1" }, [ac("a1", { flight: "NOZ1" })], []);
    expect(t?.label).toBe("NOZ1");
    expect(t?.position).toBeNull();
  });

  it("frames aircraft wider than ships", () => {
    expect(FOCUS_SPAN_DEG.aircraft).toBeGreaterThan(FOCUS_SPAN_DEG.vessel);
    expect(FOCUS_ZOOM.aircraft).toBeLessThan(FOCUS_ZOOM.vessel);
  });
});
