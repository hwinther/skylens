/**
 * Simulator kinematics: DTO → sample conversion (units, heading fallbacks, `seen` backdating), the
 * flight-path pitch, terrain clearance, SimTracker's smooth blending / staleness, and the satellite
 * state used for the orbital cockpit view.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { AircraftDto, VesselDto } from "@/api/types";
import { buildSatrec, satelliteStateAt } from "@/ar/satellites";
import {
  AIRCRAFT_PITCH_DEG,
  aircraftSample,
  clampToTerrain,
  HELICOPTER_PITCH_DEG,
  FEET_TO_M,
  MAX_PITCH_DEG,
  MIN_CLEARANCE_M,
  pitchFor,
  horizonDipDeg,
  SATELLITE_BELOW_HORIZON_DEG,
  satelliteSample,
  vesselSample,
  VESSEL_EYE_M,
  type SimSample,
} from "@/sim/simPose";
import {
  AIRCRAFT_MAX_EXTRAPOLATE_S,
  AIRCRAFT_STALE_AFTER_S,
  SATELLITE_MAX_EXTRAPOLATE_S,
  VESSEL_MAX_EXTRAPOLATE_S,
} from "@/ar/positionTracker";
import { BLEND_MS, SimTracker, trackLimits } from "@/sim/tracker";

const T0 = 1_800_000_000_000;

const ac = (over: Partial<AircraftDto> = {}): AircraftDto => ({
  hex: "47a1b2",
  lat: 59.9,
  lon: 10.7,
  alt: 10_000,
  gs: 400,
  trk: 90,
  vr: 0,
  seen: 0,
  ...over,
});

const sample = (over: Partial<SimSample> = {}): SimSample => ({
  kind: "aircraft",
  lat: 60,
  lon: 10,
  altM: 3000,
  speedMps: 200,
  headingDeg: 0,
  vertMps: 0,
  basePitchDeg: 0,
  timeMs: T0,
  ...over,
});

describe("aircraftSample", () => {
  it("converts feet, knots and ft/min to SI and backdates by `seen`", () => {
    const s = aircraftSample(ac({ vr: 1000, seen: 2 }), T0)!;
    expect(s.altM).toBeCloseTo(10_000 * FEET_TO_M);
    expect(s.speedMps).toBeCloseTo(400 * 0.514444);
    expect(s.vertMps).toBeCloseTo(1000 * 0.00508);
    expect(s.headingDeg).toBe(90);
    expect(s.timeMs).toBe(T0 - 2000);
  });

  it("looks a little down, and further down from a helicopter", () => {
    expect(aircraftSample(ac(), T0)!.basePitchDeg).toBe(AIRCRAFT_PITCH_DEG);
    expect(aircraftSample(ac({ cat: "A7" }), T0)!.basePitchDeg).toBe(HELICOPTER_PITCH_DEG);
  });

  it("times the position by seenPos, not by the age of the last message", () => {
    // A fresh velocity message (seen 0.2 s) while the position itself is 2.8 s old.
    expect(aircraftSample(ac({ seen: 0.2, seenPos: 2.8 }), T0)!.timeMs).toBe(T0 - 2800);
    // Sources without seenPos fall back to seen.
    expect(aircraftSample(ac({ seen: 0.2, seenPos: null }), T0)!.timeMs).toBe(T0 - 200);
  });

  it("is tagged as an aircraft (which picks its stale / extrapolation limits)", () => {
    expect(aircraftSample(ac(), T0)!.kind).toBe("aircraft");
  });

  it("returns null without a position", () => {
    expect(aircraftSample(ac({ lat: null }), T0)).toBeNull();
  });
});

describe("vesselSample", () => {
  const v = (over: Partial<VesselDto> = {}): VesselDto =>
    ({ mmsi: "257000000", kind: "ship", lat: 59.8, lon: 10.6, sog: 12, cog: 200, hdg: 190, ...over }) as VesselDto;

  it("looks along the bow heading at eye height", () => {
    const s = vesselSample(v(), T0)!;
    expect(s.headingDeg).toBe(190);
    expect(s.altM).toBe(VESSEL_EYE_M);
  });

  it("falls back to course over ground when heading is unavailable (AIS 511)", () => {
    expect(vesselSample(v({ hdg: 511 }), T0)!.headingDeg).toBe(200);
    expect(vesselSample(v({ hdg: null }), T0)!.headingDeg).toBe(200);
  });
});

describe("pitch and terrain", () => {
  it("pitches up along the flight path and clamps spikes", () => {
    expect(pitchFor(sample({ speedMps: 100, vertMps: 10 }))).toBeCloseTo(5.71, 1);
    expect(pitchFor(sample({ speedMps: 50, vertMps: 500 }))).toBe(MAX_PITCH_DEG);
    expect(pitchFor(sample({ speedMps: 0, vertMps: 5 }))).toBe(0);
  });

  it("adds the base pitch to the flight path", () => {
    expect(pitchFor(sample({ basePitchDeg: -30 }))).toBe(-30);
  });

  it("knows how far the horizon dips with altitude", () => {
    expect(horizonDipDeg(0)).toBe(0);
    expect(horizonDipDeg(400_000)).toBeCloseTo(19.8, 0); // ISS
    expect(horizonDipDeg(20_200_000)).toBeCloseTo(76.1, 0); // GPS
  });

  it("keeps the camera above known terrain", () => {
    expect(clampToTerrain(100, 400)).toBe(400 + MIN_CLEARANCE_M);
    expect(clampToTerrain(1000, 400)).toBe(1000);
    expect(clampToTerrain(100, undefined)).toBe(100);
  });
});

describe("SimTracker", () => {
  it("dead-reckons along the heading between samples", () => {
    const t = new SimTracker();
    t.update(sample({ headingDeg: 0, speedMps: 111.32 }), T0);
    const p = t.pose(T0 + 10_000)!; // 10 s north at ~0.01°/s
    expect(p.lat).toBeCloseTo(60.01, 3);
    expect(p.lon).toBeCloseTo(10, 6);
  });

  it("blends a correction in instead of jumping", () => {
    const t = new SimTracker();
    t.update(sample({ speedMps: 0 }), T0);
    t.pose(T0);
    // The truth turns out to be 0.01° further north.
    t.update(sample({ speedMps: 0, lat: 60.01, timeMs: T0 + 1000 }), T0 + 1000);
    const right = t.pose(T0 + 1000)!.lat;
    const mid = t.pose(T0 + 1000 + BLEND_MS / 2)!.lat;
    const done = t.pose(T0 + 1000 + BLEND_MS + 1)!.lat;
    expect(right).toBeCloseTo(60, 6);
    expect(mid).toBeCloseTo(60.005, 4);
    expect(done).toBeCloseTo(60.01, 6);
  });

  it("eases heading changes and takes the short way round north", () => {
    const t = new SimTracker();
    t.update(sample({ headingDeg: 350 }), T0);
    t.pose(T0);
    t.update(sample({ headingDeg: 10, timeMs: T0 + 100 }), T0 + 100);
    // 100 ms into a 0.6 s time constant: ~15% of the 20° turn, clockwise through 0, not back via 180.
    const h = t.pose(T0 + 100)!.headingDeg;
    expect(h).toBeGreaterThan(352);
    expect(h).toBeLessThan(354);
  });

  it("stops extrapolating and flags the signal as lost", () => {
    const t = new SimTracker();
    t.update(sample({ headingDeg: 0, speedMps: 111.32 }), T0);
    const fresh = t.pose(T0 + 1000)!;
    expect(fresh.stale).toBe(false);
    const a = t.pose(T0 + AIRCRAFT_MAX_EXTRAPOLATE_S * 1000)!;
    const b = t.pose(T0 + (AIRCRAFT_MAX_EXTRAPOLATE_S + 60) * 1000)!;
    expect(b.lat).toBeCloseTo(a.lat, 9);
    expect(t.pose(T0 + (AIRCRAFT_STALE_AFTER_S + 1) * 1000)!.stale).toBe(true);
  });

  it("keeps flying when a moving object repeats the same position", () => {
    // A replayed fixture (or a snapshot before the next position message) repeats the position with a
    // fresh timestamp. The camera must not be dragged back to it every second.
    const t = new SimTracker();
    t.update(sample({ headingDeg: 0, speedMps: 111.32 }), T0);
    t.pose(T0);
    for (let i = 1; i <= 5; i++) {
      t.update(sample({ headingDeg: 0, speedMps: 111.32, timeMs: T0 + i * 1000 }), T0 + i * 1000);
      t.pose(T0 + i * 1000);
    }
    const p = t.pose(T0 + 5000)!;
    expect(p.lat).toBeCloseTo(60.005, 4); // 5 s north at ~0.001°/s, not back at 60
    expect(p.ageS).toBeCloseTo(5, 3); // the position keeps ageing, so the HUD can go stale
  });

  it("accepts a repeated position from a stationary object", () => {
    const t = new SimTracker();
    t.update(sample({ speedMps: 0 }), T0);
    t.update(sample({ speedMps: 0, timeMs: T0 + 20_000 }), T0 + 20_000);
    expect(t.pose(T0 + 20_000)!.stale).toBe(false); // a moored vessel isn't "signal lost"
  });

  // "Signal lost" depends on what is followed: vessels report far less often than aircraft.
  const staleAt = (over: Partial<SimSample>, ageS: number) => {
    const t = new SimTracker();
    t.update(sample(over), T0);
    return t.pose(T0 + ageS * 1000)!.stale;
  };

  it("flags an aircraft as lost after 30 s", () => {
    expect(staleAt({ kind: "aircraft" }, 20)).toBe(false);
    expect(staleAt({ kind: "aircraft" }, 31)).toBe(true);
  });

  it("flags a moving vessel as lost after 120 s", () => {
    expect(staleAt({ kind: "vessel", speedMps: 6 }, 100)).toBe(false);
    expect(staleAt({ kind: "vessel", speedMps: 6 }, 121)).toBe(true);
  });

  it("flags a stationary vessel as lost only after 420 s", () => {
    expect(staleAt({ kind: "vessel", speedMps: 0 }, 300)).toBe(false);
    expect(staleAt({ kind: "vessel", speedMps: 0 }, 421)).toBe(true);
  });

  it("keeps the satellite thresholds (15 s stale, 30 s extrapolation)", () => {
    expect(trackLimits("satellite", 7600)).toEqual({ staleAfterS: 15, maxExtrapolateS: 30 });
    expect(staleAt({ kind: "satellite" }, 15)).toBe(false);
    expect(staleAt({ kind: "satellite" }, 16)).toBe(true);
  });

  it.each([
    ["aircraft", 111.32, AIRCRAFT_MAX_EXTRAPOLATE_S],
    ["vessel", 111.32, VESSEL_MAX_EXTRAPOLATE_S],
    ["satellite", 111.32, SATELLITE_MAX_EXTRAPOLATE_S],
  ] as const)("stops dead-reckoning a %s at its own cap", (kind, speedMps, capS) => {
    const t = new SimTracker();
    t.update(sample({ kind, speedMps, headingDeg: 0 }), T0);
    const before = t.pose(T0 + (capS - 1) * 1000)!.lat;
    const atCap = t.pose(T0 + capS * 1000)!.lat;
    const after = t.pose(T0 + (capS + 100) * 1000)!.lat;
    expect(atCap - before).toBeCloseTo(0.001, 5); // still moving up to the cap
    expect(atCap).toBeCloseTo(60 + capS * 0.001, 3);
    expect(after).toBeCloseTo(atCap, 9);
  });

  it("ignores out-of-order samples", () => {
    const t = new SimTracker();
    t.update(sample({ timeMs: T0 + 5000, lat: 61 }), T0 + 5000);
    t.update(sample({ timeMs: T0, lat: 50 }), T0 + 5000);
    expect(t.latest!.lat).toBe(61);
  });
});

describe("satelliteStateAt", () => {
  const fixture = JSON.parse(
    readFileSync(path.resolve(__dirname, "../../backend/tests/Api.Tests/fixtures/tle.json"), "utf8"),
  ) as { stations: { OBJECT_NAME: string; EPOCH: string }[] };
  const iss = fixture.stations.find((s) => s.OBJECT_NAME.startsWith("ISS"))!;
  const satrec = buildSatrec(iss as never)!;
  const at = new Date(new Date(`${iss.EPOCH.slice(0, 19)}Z`).getTime() + 3600_000);

  it("puts the ISS in low Earth orbit, moving at orbital ground speed", () => {
    const s = satelliteStateAt(satrec, at)!;
    expect(s.altKm).toBeGreaterThan(380);
    expect(s.altKm).toBeLessThan(440);
    expect(Math.abs(s.lat)).toBeLessThanOrEqual(52);
    expect(s.headingDeg).toBeGreaterThanOrEqual(0);
    expect(s.headingDeg).toBeLessThan(360);
    expect(s.groundSpeedKmS).toBeGreaterThan(6.5);
    expect(s.groundSpeedKmS).toBeLessThan(8);
  });

  it("becomes a sample in metres, looking just below the horizon", () => {
    const s = satelliteStateAt(satrec, at)!;
    const smp = satelliteSample(s, at.getTime());
    expect(smp.altM).toBeCloseTo(s.altKm * 1000);
    expect(smp.basePitchDeg).toBeCloseTo(-(horizonDipDeg(smp.altM) + SATELLITE_BELOW_HORIZON_DEG));
    expect(smp.basePitchDeg).toBeLessThan(-25);
  });
});
