/**
 * "Signal lost" (src/ar/signalLost): the per-kind thresholds from trackLimits, the phases a tracked
 * object goes through (fresh → dead-reckoning → lost → fresh again) on fake time, and why the tracker's
 * sample (not the DTO's own age) decides: the own feed re-sends a quiet aircraft's last position with
 * its last seenPos.
 */

import type { AircraftDto } from "@/api/types";
import {
  AIRCRAFT_STALE_AFTER_S,
  MOVING_MPS,
  PositionTracker,
  SATELLITE_STALE_AFTER_S,
  VESSEL_MOVING_STALE_AFTER_S,
  VESSEL_STATIONARY_STALE_AFTER_S,
  type PositionSample,
  type TrackKind,
} from "@/ar/positionTracker";
import {
  formatAge,
  isSignalLost,
  LIVE_AGE_S,
  lostAgeS,
  lostTag,
  sampleAgeS,
  trackPhase,
} from "@/ar/signalLost";
import { vesselMotionSample } from "@/ar/surfaceBand";
import { aircraftSample } from "@/sim/simPose";
import { SimTracker } from "@/sim/tracker";

const T0 = 1_800_000_000_000;

const sample = (kind: TrackKind, speedMps: number, timeMs = T0): PositionSample => ({
  kind,
  lat: 60,
  lon: 10,
  altM: 0,
  speedMps,
  headingDeg: 90,
  vertMps: 0,
  timeMs,
});

const ac = (over: Partial<AircraftDto> = {}): AircraftDto =>
  ({
    hex: "abc123",
    lat: 60,
    lon: 10,
    alt: 10_000,
    gs: 216.4, // ≈ 111 m/s
    trk: 0,
    vr: 0,
    seen: 0,
    seenPos: 0.3,
    ...over,
  }) as AircraftDto;

const s = (seconds: number) => seconds * 1000;

describe("thresholds per kind", () => {
  it.each([
    ["aircraft", 200, AIRCRAFT_STALE_AFTER_S],
    ["moving vessel", 5, VESSEL_MOVING_STALE_AFTER_S],
    ["stationary vessel", 0, VESSEL_STATIONARY_STALE_AFTER_S],
    ["satellite", 7000, SATELLITE_STALE_AFTER_S],
  ] as const)("%s: lost only after its limit", (name, speed, limitS) => {
    const kind: TrackKind = name.includes("vessel") ? "vessel" : (name as TrackKind);
    const x = sample(kind, speed);
    expect(isSignalLost(x, T0 + s(limitS))).toBe(false); // exactly at the limit: not yet
    expect(isSignalLost(x, T0 + s(limitS) + 1)).toBe(true);
    expect(lostAgeS(x, T0 + s(limitS))).toBeNull();
    expect(lostAgeS(x, T0 + s(limitS + 5))).toBe(limitS + 5);
  });

  it("uses the documented limits: aircraft 30 s, moving ship 2 min, moored ship 7 min", () => {
    expect([AIRCRAFT_STALE_AFTER_S, VESSEL_MOVING_STALE_AFTER_S, VESSEL_STATIONARY_STALE_AFTER_S]).toEqual([30, 120, 420]);
  });

  it("a vessel counts as moving only above MOVING_MPS", () => {
    const atLimit = T0 + s(VESSEL_MOVING_STALE_AFTER_S + 1);
    expect(isSignalLost(sample("vessel", MOVING_MPS + 0.1), atLimit)).toBe(true);
    expect(isSignalLost(sample("vessel", MOVING_MPS), atLimit)).toBe(false);
  });

  it("phases: fresh under LIVE_AGE_S, then dead-reckoning, then lost", () => {
    const x = sample("aircraft", 200);
    expect(trackPhase(x, T0)).toBe("fresh");
    expect(trackPhase(x, T0 + s(LIVE_AGE_S) - 1)).toBe("fresh");
    expect(trackPhase(x, T0 + s(LIVE_AGE_S))).toBe("dead-reckoning");
    expect(trackPhase(x, T0 + s(AIRCRAFT_STALE_AFTER_S))).toBe("dead-reckoning");
    expect(trackPhase(x, T0 + s(AIRCRAFT_STALE_AFTER_S + 1))).toBe("lost");
  });

  it("an age is never negative (a sample timed slightly in the future)", () => {
    expect(sampleAgeS(sample("aircraft", 0, T0 + 500), T0)).toBe(0);
    expect(trackPhase(sample("aircraft", 0, T0 + 500), T0)).toBe("fresh");
  });

  it("lostAgeS is null without a sample", () => {
    expect(lostAgeS(null, T0)).toBeNull();
    expect(lostAgeS(undefined, T0)).toBeNull();
  });
});

describe("wording", () => {
  it("seconds under 90 s, minutes after", () => {
    expect(formatAge(45)).toBe("45 s");
    expect(formatAge(89.4)).toBe("89 s");
    expect(formatAge(90)).toBe("2 min");
    expect(formatAge(420)).toBe("7 min");
    expect(lostTag(45)).toBe("lost · 45 s");
  });
});

describe("transitions through the AR tracker on fake time", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });
  afterEach(() => jest.useRealTimers());

  const phaseOf = (t: PositionTracker, id: string) => {
    const x = t.sampleOf(id);
    return x ? trackPhase(x, Date.now()) : null;
  };

  it("aircraft: fresh → dead-reckoning → lost while the feed repeats the last position → fresh again", () => {
    const t = new PositionTracker();
    const feed = (dto: AircraftDto) => {
      const now = Date.now();
      t.sync([dto], (a) => a.hex, (a) => aircraftSample(a, now), now);
    };

    feed(ac());
    expect(phaseOf(t, "abc123")).toBe("fresh");

    // The backend keeps sending the same position with the same seenPos once the aircraft goes quiet:
    // the DTO alone would look fresh forever, the tracker keeps the original position time.
    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(1000);
      feed(ac());
    }
    expect(phaseOf(t, "abc123")).toBe("dead-reckoning");
    expect(trackPhase(aircraftSample(ac(), Date.now())!, Date.now())).toBe("fresh"); // the DTO's own view

    for (let i = 0; i < 25; i++) {
      jest.advanceTimersByTime(1000);
      feed(ac());
    }
    expect(phaseOf(t, "abc123")).toBe("lost");
    expect(lostAgeS(t.sampleOf("abc123"), Date.now())).toBe(35);

    // A real new position arrives.
    jest.advanceTimersByTime(1000);
    feed(ac({ lat: 60.02 }));
    expect(phaseOf(t, "abc123")).toBe("fresh");
    expect(lostAgeS(t.sampleOf("abc123"), Date.now())).toBeNull();
  });

  it("aircraft: also lost when it is simply not updated, and the DTO's own growing seenPos counts", () => {
    const t = new PositionTracker();
    const now = Date.now();
    t.sync([ac({ seenPos: 31 })], (a) => a.hex, (a) => aircraftSample(a, now), now);
    expect(phaseOf(t, "abc123")).toBe("lost");
  });

  it("moving vessel: lost after 2 min without a new position, fresh on the next one", () => {
    const t = new PositionTracker();
    const v = { mmsi: "257000001", lat: 60, lon: 10, sog: 12, cog: 45, seen: 0 };
    const feed = (lat: number) => {
      const now = Date.now();
      t.sync([{ ...v, lat }], (x) => x.mmsi, (x) => vesselMotionSample(x, now), now);
    };
    feed(60);
    jest.advanceTimersByTime(s(VESSEL_MOVING_STALE_AFTER_S - 1));
    feed(60); // repeated position
    expect(phaseOf(t, v.mmsi)).toBe("dead-reckoning");
    jest.advanceTimersByTime(s(2));
    expect(phaseOf(t, v.mmsi)).toBe("lost");
    feed(60.01);
    expect(phaseOf(t, v.mmsi)).toBe("fresh");
  });

  it("stationary vessel: a moored ship repeating its position is accepted as fresh (no false alarm)", () => {
    const t = new PositionTracker();
    const v = { mmsi: "257000002", lat: 60, lon: 10, sog: 0, cog: null, seen: 0 };
    for (let i = 0; i < 10; i++) {
      const now = Date.now();
      t.sync([v], (x) => x.mmsi, (x) => vesselMotionSample(x, now), now);
      jest.advanceTimersByTime(s(60));
    }
    expect(phaseOf(t, v.mmsi)).not.toBe("lost");
  });

  it("the simulator's stale flag is the same decision", () => {
    const sim = new SimTracker();
    sim.update(aircraftSample(ac({ seenPos: 0 }), Date.now())!, Date.now());
    jest.advanceTimersByTime(s(AIRCRAFT_STALE_AFTER_S));
    expect(sim.pose(Date.now())!.stale).toBe(false);
    jest.advanceTimersByTime(1000);
    expect(sim.pose(Date.now())!.stale).toBe(true);
  });
});
