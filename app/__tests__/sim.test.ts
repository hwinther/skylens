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
import { BLEND_MS, MAX_EXTRAPOLATE_S, SimTracker, STALE_AFTER_S } from "@/sim/tracker";

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
    const a = t.pose(T0 + MAX_EXTRAPOLATE_S * 1000)!;
    const b = t.pose(T0 + (MAX_EXTRAPOLATE_S + 60) * 1000)!;
    expect(b.lat).toBeCloseTo(a.lat, 9);
    expect(t.pose(T0 + (STALE_AFTER_S + 1) * 1000)!.stale).toBe(true);
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
