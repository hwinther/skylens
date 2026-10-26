/**
 * Shared observer position (resolveObserver: demo home in demo mode, else the live fix, else the
 * demo placeholder) and the hub "status" handling (aircraftStore.feedStatus is set by a status
 * frame, cleared by the next snapshot, and leaves vessels alone; feedStatusMessage wording).
 */

import { resolveObserver } from "@/components/useObserver";
import { feedStatusMessage } from "@/components/feedStatus";
import { useAircraftStore } from "@/state/aircraftStore";
import { useObserverStore } from "@/state/observerStore";
import { useVesselStore } from "@/state/vesselStore";
import { DEMO_HOME } from "@/mock/mockFeed";
import type { AircraftDto } from "@/api/types";

const BERGEN = { lat: 60.39, lon: 5.32 };

describe("resolveObserver", () => {
  it("uses the demo home in demo mode, even with a live fix", () => {
    expect(resolveObserver(true, BERGEN)).toBe(DEMO_HOME);
  });

  it("uses the live fix in live mode", () => {
    expect(resolveObserver(false, BERGEN)).toBe(BERGEN);
  });

  it("falls back to the demo home until the first fix", () => {
    expect(resolveObserver(false, null)).toBe(DEMO_HOME);
  });
});

describe("observerStore", () => {
  it("holds the published position", () => {
    useObserverStore.getState().setPosition(BERGEN);
    expect(useObserverStore.getState().position).toEqual(BERGEN);
    useObserverStore.getState().setPosition(null);
    expect(useObserverStore.getState().position).toBeNull();
  });
});

describe("aircraftStore feedStatus", () => {
  const ac = { hex: "4ac9e1", src: "adsblol", lat: 60.4, lon: 5.3 } as AircraftDto;

  beforeEach(() => {
    useAircraftStore.setState({ byHex: {}, lastSnapshotAt: 0, feedStatus: null });
    useVesselStore.setState({ byMmsi: {}, lastSnapshotAt: 0 });
  });

  it("a status frame clears the aircraft and records the reason", () => {
    useAircraftStore.getState().setSnapshot([ac]);
    useAircraftStore.getState().setFeedStatus("adsblol-upstream-error");
    const s = useAircraftStore.getState();
    expect(s.byHex).toEqual({});
    expect(s.feedStatus).toBe("adsblol-upstream-error");
  });

  it("the next snapshot clears the status", () => {
    useAircraftStore.getState().setFeedStatus("away-mode-unconfigured");
    useAircraftStore.getState().setSnapshot([ac]);
    expect(useAircraftStore.getState().feedStatus).toBeNull();
    expect(Object.keys(useAircraftStore.getState().byHex)).toEqual(["4ac9e1"]);
  });

  it("does not touch the vessel store (status frames are aircraft-only)", () => {
    useVesselStore.getState().setSnapshot([{ mmsi: "257011940", kind: "ship", lat: 60.4, lon: 5.3 }]);
    useAircraftStore.getState().setFeedStatus("adsblol-upstream-error");
    expect(Object.keys(useVesselStore.getState().byMmsi)).toEqual(["257011940"]);
  });

  it("clear() resets the status", () => {
    useAircraftStore.getState().setFeedStatus("adsblol-budget-exhausted");
    useAircraftStore.getState().clear();
    expect(useAircraftStore.getState().feedStatus).toBeNull();
  });
});

describe("feedStatusMessage", () => {
  it.each([
    ["adsblol-budget-exhausted", "usage limit"],
    ["adsbx-budget-exhausted", "usage limit"],
    ["adsblol-upstream-error", "isn't responding"],
    ["adsblol-unconfigured", "no away-mode aircraft source is configured"],
    ["away-mode-unconfigured", "no away-mode aircraft source is configured"],
  ])("%s mentions %s", (reason, phrase) => {
    expect(feedStatusMessage(reason)).toContain(phrase);
  });

  it("falls back to showing the raw reason", () => {
    expect(feedStatusMessage("something-new")).toContain("something-new");
  });
});
