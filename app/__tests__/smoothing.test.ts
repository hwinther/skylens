import {
  deadReckon,
  KNOTS_TO_MPS,
  lowPass,
  lowPassAngle,
  smoothPose,
} from "@/ar/smoothing";
import { geodeticToEnu, METERS_PER_DEG } from "@/ar/geo";
import type { CameraPose } from "@/ar/orientation";

describe("lowPass", () => {
  it("blends toward the target by alpha", () => {
    expect(lowPass(0, 10, 0.15)).toBeCloseTo(1.5, 9);
    expect(lowPass(10, 10, 0.15)).toBeCloseTo(10, 9);
  });

  it("converges to the target after many steps", () => {
    let v = 0;
    for (let i = 0; i < 200; i++) v = lowPass(v, 100, 0.15);
    expect(v).toBeCloseTo(100, 3);
  });
});

describe("lowPassAngle wrap safety", () => {
  it("filters across the 360→0 boundary via the short path", () => {
    // prev 359°, next 1° — short path is +2°, so a 0.5 blend lands at ~0°.
    const out = lowPassAngle(359, 1, 0.5);
    expect(out).toBeCloseTo(0, 6);
  });

  it("does not take the long way around", () => {
    const out = lowPassAngle(10, 350, 0.5); // short path is −20 → 0°
    expect(out).toBeCloseTo(0, 6);
  });

  it("stays within [0,360)", () => {
    const out = lowPassAngle(2, 358, 0.9);
    expect(out).toBeGreaterThanOrEqual(0);
    expect(out).toBeLessThan(360);
  });
});

describe("smoothPose", () => {
  it("smooths azimuth with wrap safety and passes elevation/roll", () => {
    const prev: CameraPose = { azimuth: 359, elevation: 0, roll: 0 };
    const next: CameraPose = { azimuth: 3, elevation: 10, roll: 4 };
    const out = smoothPose(prev, next, 0.5);
    expect(out.azimuth).toBeCloseTo(1, 4); // short path midpoint of 359→3(≡363)
    expect(out.elevation).toBeCloseTo(5, 6);
    expect(out.roll).toBeCloseTo(2, 6);
  });
});

describe("deadReckon", () => {
  it("advances distance ≈ gs·dt along the track", () => {
    const gs = 450; // knots
    const dt = 3; // seconds
    const start = { lat: 59.9, lon: 10.7, alt: 3000, gs, trk: 0, vr: 0 }; // due north
    const out = deadReckon(start, dt);

    const enu = geodeticToEnu(
      { lat: start.lat, lon: start.lon, alt: start.alt },
      { lat: out.lat, lon: out.lon, alt: out.alt },
    );
    const traveled = Math.hypot(enu.e, enu.n);
    const expected = gs * KNOTS_TO_MPS * dt;
    expect(traveled).toBeCloseTo(expected, 0); // ~695 m
  });

  it("track 90° moves due east", () => {
    const start = { lat: 0, lon: 0, alt: 0, gs: 600, trk: 90, vr: 0 };
    const out = deadReckon(start, 2);
    expect(out.lon).toBeGreaterThan(0);
    expect(Math.abs(out.lat)).toBeLessThan(1e-9);
  });

  it("track 180° moves due south", () => {
    const start = { lat: 10, lon: 10, alt: 0, gs: 600, trk: 180, vr: 0 };
    const out = deadReckon(start, 2);
    expect(out.lat).toBeLessThan(10);
    expect(out.lon).toBeCloseTo(10, 9);
  });

  it("applies vertical rate to altitude", () => {
    const start = { lat: 0, lon: 0, alt: 1000, gs: 0, trk: 0, vr: 1200 }; // 1200 fpm climb
    const out = deadReckon(start, 60); // 1 minute
    // 1200 fpm ≈ 1200 ft/min = 365.76 m/min climb over 60 s.
    expect(out.alt - 1000).toBeCloseTo(1200 * 0.00508 * 60, 3);
  });

  it("returns the original position when gs/trk are missing", () => {
    const start = { lat: 5, lon: 6, alt: 700, gs: NaN, trk: NaN };
    const out = deadReckon(start, 5);
    expect(out).toEqual({ lat: 5, lon: 6, alt: 700 });
  });

  it("dead-reckoned northward step matches METERS_PER_DEG scaling", () => {
    const gs = 360;
    const dt = 10;
    const out = deadReckon({ lat: 0, lon: 0, alt: 0, gs, trk: 0, vr: 0 }, dt);
    const meters = out.lat * METERS_PER_DEG;
    expect(meters).toBeCloseTo(gs * KNOTS_TO_MPS * dt, 3);
  });
});
