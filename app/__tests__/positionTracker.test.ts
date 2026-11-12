/**
 * The AR position tracker: samples timed by their position's own age, repeated positions of moving
 * objects, correction blending without a discontinuity, the extrapolation cap, forgetting ids that leave
 * the snapshot, and the snap guard for teleports (a looping demo replay).
 */

import type { AircraftDto } from "@/api/types";
import {
  BLEND_MS,
  AIRCRAFT_MAX_EXTRAPOLATE_S,
  VESSEL_MAX_EXTRAPOLATE_S,
  PositionTracker,
  SNAP_MIN_M,
  TrackedPosition,
  type PositionSample,
  type TrackPoint,
} from "@/ar/positionTracker";
import { vesselMotionSample } from "@/ar/surfaceBand";
import { allFramesAsDtos } from "@/mock/mockFeed";
import { aircraftSample } from "@/sim/simPose";

const T0 = 1_800_000_000_000;
/** ~0.001° of latitude per second. */
const NORTH_111 = 111.32;

const sample = (over: Partial<PositionSample> = {}): PositionSample => ({
  kind: "aircraft",
  lat: 60,
  lon: 10,
  altM: 1000,
  speedMps: 0,
  headingDeg: 0,
  vertMps: 0,
  timeMs: T0,
  ...over,
});

const pt = (): TrackPoint => ({ lat: 0, lon: 0, alt: 0 });

/** Feed one object as a whole snapshot and read it back. */
function single(t: PositionTracker, s: PositionSample, nowMs: number) {
  t.sync([s], () => "a", (x) => x, nowMs);
}
function at(t: PositionTracker, nowMs: number, id = "a"): TrackPoint {
  const out = pt();
  expect(t.positionAt(id, nowMs, out)).toBe(true);
  return out;
}

const ac = (over: Partial<AircraftDto> = {}): AircraftDto => ({
  hex: "abc123",
  lat: 60,
  lon: 10,
  alt: 10_000,
  gs: 216.4, // ≈ 111.32 m/s
  trk: 0,
  vr: 0,
  seen: 0,
  ...over,
} as AircraftDto);

describe("PositionTracker", () => {
  it("times the position by seenPos, not by when the snapshot arrived", () => {
    const t = new PositionTracker();
    // Received at T0, but the position was measured 2 s earlier: it's already ~0.002° further north.
    single(t, aircraftSample(ac({ seenPos: 2, seen: 0.1 }), T0)!, T0);
    expect(at(t, T0).lat).toBeCloseTo(60.002, 4);
  });

  it("treats a missing seenPos / seen as a fresh position", () => {
    const t = new PositionTracker();
    single(t, aircraftSample(ac({ seen: undefined, seenPos: undefined }), T0)!, T0);
    expect(at(t, T0).lat).toBeCloseTo(60, 9);
  });

  it("does not pull a moving object back when a snapshot repeats its position", () => {
    const t = new PositionTracker();
    single(t, sample({ speedMps: NORTH_111 }), T0);
    for (let i = 1; i <= 3; i++) {
      // Same lat/lon with a fresh time: no new position message arrived.
      const before = at(t, T0 + i * 1000).lat;
      single(t, sample({ speedMps: NORTH_111, timeMs: T0 + i * 1000 }), T0 + i * 1000);
      expect(at(t, T0 + i * 1000).lat).toBeCloseTo(before, 9);
    }
    expect(at(t, T0 + 3000).lat).toBeCloseTo(60.003, 4);
    expect(at(t, T0 + 3500).lat).toBeCloseTo(60.0035, 4);
  });

  it("keeps a stationary object where it is when it repeats its position", () => {
    const t = new PositionTracker();
    single(t, sample(), T0);
    single(t, sample({ timeMs: T0 + 5000 }), T0 + 5000);
    const p = at(t, T0 + 7000);
    expect(p.lat).toBeCloseTo(60, 9);
    expect(p.lon).toBeCloseTo(10, 9);
    expect(p.alt).toBeCloseTo(1000, 6);
  });

  it("blends a correction in without a discontinuity when the sample arrives", () => {
    const t = new PositionTracker();
    single(t, sample({ speedMps: NORTH_111 }), T0);
    // The truth turns out ~110 m further north (and a bit east) than the prediction.
    const now = T0 + 1000;
    const before = at(t, now);
    single(t, sample({ speedMps: NORTH_111, lat: 60.002, lon: 10.001, altM: 1010, timeMs: now }), now);
    const after = at(t, now);
    expect(Math.abs(after.lat - before.lat)).toBeLessThan(1e-9);
    expect(Math.abs(after.lon - before.lon)).toBeLessThan(1e-9);
    expect(Math.abs(after.alt - before.alt)).toBeLessThan(1e-6);

    // Halfway through the blend: halfway between the old track and the new one.
    const mid = at(t, now + BLEND_MS / 2);
    expect(mid.lat).toBeCloseTo((60.0015 + 60.0025) / 2, 5);
    expect(mid.lon).toBeCloseTo(10.0005, 5);
    // Faded out: on the new track.
    const done = at(t, now + BLEND_MS + 1);
    expect(done.lat).toBeCloseTo(60.002 + 0.001 * 1.001, 5);
    expect(done.lon).toBeCloseTo(10.001, 6);
    expect(done.alt).toBeCloseTo(1010, 3);
  });

  it.each([
    ["aircraft", AIRCRAFT_MAX_EXTRAPOLATE_S],
    ["vessel", VESSEL_MAX_EXTRAPOLATE_S],
  ] as const)("caps extrapolation of a %s at its own limit", (kind, capS) => {
    const t = new PositionTracker();
    single(t, sample({ kind, speedMps: NORTH_111 }), T0);
    const before = at(t, T0 + (capS - 1) * 1000);
    const a = at(t, T0 + capS * 1000);
    const b = at(t, T0 + (capS + 60) * 1000);
    expect(a.lat - before.lat).toBeCloseTo(0.001, 5);
    expect(a.lat).toBeCloseTo(60 + capS * 0.001, 3);
    expect(b.lat).toBeCloseTo(a.lat, 9);
  });

  it("takes the cap from each sample, so a vessel that stops and starts follows it", () => {
    // Mixed kinds in one tracker: the cap travels with the sample, not the tracker.
    const t = new PositionTracker();
    t.sync(
      [
        { id: "ac", s: sample({ kind: "aircraft", speedMps: NORTH_111 }) },
        { id: "ship", s: sample({ kind: "vessel", speedMps: NORTH_111 }) },
      ],
      (i) => i.id,
      (i) => i.s,
      T0,
    );
    const later = T0 + 100_000;
    expect(at(t, later, "ac").lat).toBeCloseTo(60 + AIRCRAFT_MAX_EXTRAPOLATE_S * 0.001, 3);
    expect(at(t, later, "ship").lat).toBeCloseTo(60 + 100 * 0.001, 3);
  });

  it("forgets ids that leave the snapshot or lose their position", () => {
    const t = new PositionTracker<PositionSample>();
    const items = [
      { id: "a", s: sample() as PositionSample | null },
      { id: "b", s: sample({ lat: 61 }) as PositionSample | null },
      { id: "c", s: sample({ lat: 62 }) as PositionSample | null },
    ];
    t.sync(items, (i) => i.id, (i) => i.s, T0);
    expect(t.size).toBe(3);
    t.sync([items[0], { id: "c", s: null }], (i) => i.id, (i) => i.s, T0 + 1000);
    expect(t.size).toBe(1);
    expect(t.has("a")).toBe(true);
    expect(t.positionAt("b", T0 + 1000, pt())).toBe(false);
    expect(t.positionAt("c", T0 + 1000, pt())).toBe(false);
    t.sync([], (i: { id: string }) => i.id, () => null, T0 + 2000);
    expect(t.size).toBe(0);
  });

  it("snaps a huge jump (a looping replay) instead of smearing it across the sky", () => {
    const t = new PositionTracker();
    single(t, sample({ speedMps: NORTH_111 }), T0);
    const now = T0 + 1000;
    // The replay wraps: the object reappears ~3 km behind where it was predicted.
    single(t, sample({ speedMps: NORTH_111, lat: 59.973, timeMs: now }), now);
    expect(at(t, now).lat).toBeCloseTo(59.973, 9);
  });

  it("still blends a correction under the snap distance", () => {
    const t = new PositionTracker();
    single(t, sample(), T0);
    const now = T0 + 1000;
    const dLat = (SNAP_MIN_M * 0.8) / 111_320;
    single(t, sample({ lat: 60 + dLat, timeMs: now }), now);
    expect(at(t, now).lat).toBeCloseTo(60, 9);
    expect(at(t, now + BLEND_MS).lat).toBeCloseTo(60 + dLat, 9);
  });

  it("ignores out-of-order samples but keeps the id", () => {
    const t = new PositionTracker();
    single(t, sample({ lat: 61, timeMs: T0 + 5000 }), T0 + 5000);
    single(t, sample({ lat: 50, timeMs: T0 }), T0 + 5000);
    expect(at(t, T0 + 5000).lat).toBeCloseTo(61, 9);
  });

  it("wraps longitude across the antimeridian", () => {
    const t = new PositionTracker();
    single(t, sample({ lat: 0, lon: 179.9995, speedMps: NORTH_111, headingDeg: 90 }), T0);
    expect(at(t, T0 + 1000).lon).toBeCloseTo(-179.9995, 4);
  });
});

describe("TrackedPosition", () => {
  it("never snaps without options (the simulator's behaviour)", () => {
    const t = new TrackedPosition();
    t.update(sample(), T0);
    t.update(sample({ lat: 61, timeMs: T0 + 1000 }), T0 + 1000);
    expect(t.positionAt(T0 + 1000, pt())!.lat).toBeCloseTo(60, 9);
  });

  it("returns null before the first sample", () => {
    expect(new TrackedPosition().positionAt(T0, pt())).toBeNull();
  });
});

describe("vesselMotionSample", () => {
  it("moves along cog at sog and backdates by seen", () => {
    const s = vesselMotionSample({ lat: 60, lon: 10, sog: 10, cog: 90, seen: 4 }, T0)!;
    expect(s.speedMps).toBeCloseTo(5.14444, 4);
    expect(s.headingDeg).toBe(90);
    expect(s.altM).toBe(0);
    expect(s.kind).toBe("vessel");
    expect(s.timeMs).toBe(T0 - 4000);
  });

  it("is stationary without a course or speed, and null without a position", () => {
    expect(vesselMotionSample({ lat: 60, lon: 10, sog: 10, cog: null }, T0)!.speedMps).toBe(0);
    expect(vesselMotionSample({ lat: 60, lon: 10, sog: 0, cog: 90 }, T0)!.speedMps).toBe(0);
    expect(vesselMotionSample({ lat: 60, lon: 10 }, T0)!.timeMs).toBe(T0);
    expect(vesselMotionSample({ lat: null, lon: 10 }, T0)).toBeNull();
  });
});

describe("demo replay through the tracker", () => {
  it("tracks the recorded series smoothly and snaps when it loops", () => {
    const frames = allFramesAsDtos();
    const t = new PositionTracker();
    const M = 111_320;
    const distM = (a: TrackPoint, lat: number, lon: number) =>
      Math.hypot((a.lat - lat) * M, (a.lon - lon) * M * Math.cos((lat * Math.PI) / 180));
    // Two passes, one frame per second, like startMockFeed.
    for (let i = 0; i < frames.length * 2; i++) {
      const now = T0 + i * 1000;
      const frame = frames[i % frames.length];
      t.sync(frame, (a) => a.hex, (a) => aircraftSample(a, now), now);
      for (const a of frame) {
        if (a.lat == null || a.lon == null) continue;
        // As the sample arrives the label is close to it: a frame-to-frame correction is tiny, and the
        // loop's jump back (1.8-5.6 km for the jets) snaps; only the slow ones (< 700 m) blend.
        expect(distM(at(t, now, a.hex), a.lat, a.lon)).toBeLessThan(700);
        // One blend later it is on the new track (the sample dead-reckoned by its age + 1 s).
        const expectedM = (a.gs ?? 0) * 0.514444 * (1 + (a.seen ?? 0));
        expect(distM(at(t, now + BLEND_MS, a.hex), a.lat, a.lon)).toBeLessThan(expectedM + 1);
      }
    }
  });
});
