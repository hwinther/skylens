/**
 * Surface-band math for the AR maritime layer. Three pure concerns:
 *  1. surfaceBandOffset(distanceKm) — the distance→downward-px falloff (clamp + monotonicity).
 *  2. The horizon anchor: projecting { azimuth, elevation: 0 } through the pose. No new helper is
 *     needed — the existing `project` already places an elevation-0 point on the horizon at any
 *     bearing — so we assert that behaviour here (it's what the band relies on).
 *  3. deadReckonVessel — cog/sog mapped onto the shared aircraft deadReckon (trk/gs).
 */

import {
  BAND_PX,
  SURFACE_BAND_K,
  deadReckonVessel,
  surfaceBandOffset,
} from "@/ar/surfaceBand";
import { KNOTS_TO_MPS } from "@/ar/smoothing";
import {
  DEFAULT_PROJECTION_CONFIG,
  project,
  type ProjectionConfig,
} from "@/ar/projection";
import { geodeticToEnu } from "@/ar/geo";
import type { CameraPose } from "@/ar/orientation";

describe("surfaceBandOffset", () => {
  it("clamps to the full band for very near vessels (≤ the 0.5 km floor)", () => {
    expect(surfaceBandOffset(0)).toBe(BAND_PX);
    expect(surfaceBandOffset(0.1)).toBe(BAND_PX);
    expect(surfaceBandOffset(0.5)).toBe(BAND_PX);
  });

  it("puts a ~1 km vessel a full band below the horizon (K = BAND_PX ⇒ knee at 1 km)", () => {
    expect(SURFACE_BAND_K).toBe(BAND_PX);
    expect(surfaceBandOffset(1)).toBeCloseTo(BAND_PX, 6);
  });

  it("falls to ~half a band at 2 km and toward the horizon by 20 km", () => {
    expect(surfaceBandOffset(2)).toBeCloseTo(BAND_PX / 2, 6);
    expect(surfaceBandOffset(20)).toBeLessThan(5);
    expect(surfaceBandOffset(20)).toBeGreaterThan(0);
  });

  it("never exceeds BAND_PX and never goes negative", () => {
    for (const d of [-5, 0, 0.25, 1, 3, 10, 50, 500]) {
      const o = surfaceBandOffset(d);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(BAND_PX);
    }
  });

  it("is monotonically non-increasing with distance", () => {
    let prev = Infinity;
    for (let d = 0.5; d <= 60; d += 0.5) {
      const o = surfaceBandOffset(d);
      expect(o).toBeLessThanOrEqual(prev + 1e-9);
      prev = o;
    }
  });
});

describe("horizon anchor — project({ azimuth, elevation: 0 }) is the band's basis", () => {
  const CONFIG: ProjectionConfig = { ...DEFAULT_PROJECTION_CONFIG, hFovDeg: 60, aspect: 1 };
  const NORTH_LEVEL: CameraPose = { azimuth: 0, elevation: 0, roll: 0 };

  it("a vessel dead ahead lands at horizon centre for a level, N-facing camera", () => {
    const p = project({ azimuth: 0, elevation: 0 }, NORTH_LEVEL, CONFIG);
    expect(p.onScreen).toBe(true);
    expect(p.xNdc).toBeCloseTo(0, 9); // centre-x
    expect(p.yNdc).toBeCloseTo(0, 9); // on the horizon line
  });

  it("a vessel 90° right of a N-facing 60° camera is off-screen to the right", () => {
    const p = project({ azimuth: 90, elevation: 0 }, NORTH_LEVEL, CONFIG);
    expect(p.onScreen).toBe(false);
    expect(p.xNdc).toBeGreaterThan(1);
  });

  it("a vessel off the bow (25°) sits right-of-centre but still exactly on the horizon", () => {
    const p = project({ azimuth: 25, elevation: 0 }, NORTH_LEVEL, CONFIG);
    expect(p.onScreen).toBe(true);
    expect(p.xNdc).toBeGreaterThan(0);
    expect(p.yNdc).toBeCloseTo(0, 9); // pinned to the horizon regardless of bearing
  });
});

describe("deadReckonVessel — cog/sog map onto the shared deadReckon (trk/gs)", () => {
  it("advances a moving ship east for cog 90", () => {
    const out = deadReckonVessel({ lat: 0, lon: 0, sog: 20, cog: 90 }, 30);
    expect(out.lon).toBeGreaterThan(0);
    expect(Math.abs(out.lat)).toBeLessThan(1e-9);
  });

  it("travels sog·dt metres along the course (knots → m/s like gs)", () => {
    const sogKn = 15;
    const dt = 20;
    const out = deadReckonVessel({ lat: 59.9, lon: 10.7, sog: sogKn, cog: 0 }, dt);
    const enu = geodeticToEnu(
      { lat: 59.9, lon: 10.7, alt: 0 },
      { lat: out.lat, lon: out.lon, alt: 0 },
    );
    const traveled = Math.hypot(enu.e, enu.n);
    expect(traveled).toBeCloseTo(sogKn * KNOTS_TO_MPS * dt, 1);
  });

  it("leaves a stationary or course-less vessel where it is (no fabricated drift)", () => {
    expect(deadReckonVessel({ lat: 5, lon: 6, sog: 0, cog: 90 }, 30)).toEqual({ lat: 5, lon: 6 });
    expect(deadReckonVessel({ lat: 5, lon: 6, sog: 12 }, 30)).toEqual({ lat: 5, lon: 6 });
    expect(deadReckonVessel({ lat: 5, lon: 6, sog: 12, cog: null }, 30)).toEqual({ lat: 5, lon: 6 });
  });
});
