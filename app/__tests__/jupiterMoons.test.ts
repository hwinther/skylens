/**
 * Pure Galilean-moon projection. astronomy-engine is a deterministic function of the instant, so these
 * hold at a FIXED date with loose real-world orbital bounds plus self-consistency (the projected
 * separation can only shrink relative to the true 3-D separation) and an independent reimplementation
 * of the plane-of-sky projection for one moon (Io) that must match the module to machine precision.
 */

import * as Astro from "astronomy-engine";
import {
  AU_KM,
  computeJupiterMoons,
  JUPITER_EQUATORIAL_RADIUS_KM,
  RAD2ARCSEC,
} from "@/ar/jupiterMoons";

const DATE = new Date("2026-07-15T00:00:00Z");

// Independent Jupiter geocentric distance (km) for the self-consistency bound + Io cross-check.
const jup = Astro.GeoVector(Astro.Body.Jupiter, DATE, true);
const JUPITER_DISTANCE_KM = Math.hypot(jup.x, jup.y, jup.z) * AU_KM;

describe("computeJupiterMoons — the four Galilean moons at a fixed instant", () => {
  const view = computeJupiterMoons(DATE);
  const byKey = new Map(view.moons.map((m) => [m.key, m]));

  it("returns exactly the four moons in inner→outer order with unique keys", () => {
    expect(view.moons.map((m) => m.key)).toEqual(["io", "europa", "ganymede", "callisto"]);
    expect(new Set(view.moons.map((m) => m.key)).size).toBe(4);
  });

  it("places each moon within its real orbital-radius range", () => {
    // Loose real bounds — the instantaneous 3-D separation stays within a few % of the mean semi-major
    // axis, and all four hold comfortably at this instant.
    expect(byKey.get("io")!.distanceKmFromJupiter).toBeGreaterThanOrEqual(400_000);
    expect(byKey.get("io")!.distanceKmFromJupiter).toBeLessThanOrEqual(430_000);
    expect(byKey.get("europa")!.distanceKmFromJupiter).toBeGreaterThanOrEqual(660_000);
    expect(byKey.get("europa")!.distanceKmFromJupiter).toBeLessThanOrEqual(680_000);
    expect(byKey.get("ganymede")!.distanceKmFromJupiter).toBeGreaterThanOrEqual(1_060_000);
    expect(byKey.get("ganymede")!.distanceKmFromJupiter).toBeLessThanOrEqual(1_080_000);
    expect(byKey.get("callisto")!.distanceKmFromJupiter).toBeGreaterThanOrEqual(1_860_000);
    expect(byKey.get("callisto")!.distanceKmFromJupiter).toBeLessThanOrEqual(1_900_000);
  });

  it("projects each moon to a non-zero offset that can only be smaller than its 3-D separation", () => {
    for (const m of view.moons) {
      const projected = Math.hypot(m.xArcsec, m.yArcsec);
      const full = (m.distanceKmFromJupiter / JUPITER_DISTANCE_KM) * RAD2ARCSEC;
      expect(projected).toBeGreaterThan(0);
      // Dropping the line-of-sight component can only shrink the separation (allow a hair for rounding).
      expect(projected).toBeLessThanOrEqual(full + 1e-9);
    }
  });

  it("gives Jupiter an apparent angular radius in its real range (~14–25″)", () => {
    expect(view.jupiterAngularRadiusArcsec).toBeGreaterThanOrEqual(14);
    expect(view.jupiterAngularRadiusArcsec).toBeLessThanOrEqual(25);
  });

  it("exposes maxAbsXArcsec = max(|xArcsec|) across the four", () => {
    const expected = Math.max(...view.moons.map((m) => Math.abs(m.xArcsec)));
    expect(view.maxAbsXArcsec).toBe(expected);
  });

  it("matches an independent reimplementation of the projection for Io (within 1e-9)", () => {
    // Re-derive Io's plane-of-sky offset directly: jovicentric position projected onto an {east, north}
    // basis perpendicular to the Earth→Jupiter line of sight. Must equal the module to machine precision.
    const info = Astro.JupiterMoons(DATE);
    const jupiterGeo: [number, number, number] = [jup.x, jup.y, jup.z];
    const jd = Math.hypot(...jupiterGeo);
    const losHat: [number, number, number] = [jupiterGeo[0] / jd, jupiterGeo[1] / jd, jupiterGeo[2] / jd];
    const cross = (
      a: [number, number, number],
      b: [number, number, number],
    ): [number, number, number] => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const dot = (a: [number, number, number], b: [number, number, number]) =>
      a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const eastRaw = cross([0, 0, 1], losHat);
    const eLen = Math.hypot(...eastRaw);
    const east: [number, number, number] = [eastRaw[0] / eLen, eastRaw[1] / eLen, eastRaw[2] / eLen];
    const north = cross(losHat, east);
    const rel: [number, number, number] = [info.io.x, info.io.y, info.io.z];
    const xArcsec = (dot(rel, east) / jd) * RAD2ARCSEC;
    const yArcsec = (dot(rel, north) / jd) * RAD2ARCSEC;

    const io = byKey.get("io")!;
    expect(io.xArcsec).toBeCloseTo(xArcsec, 9);
    expect(io.yArcsec).toBeCloseTo(yArcsec, 9);
  });
});

describe("module constants", () => {
  it("uses the IAU astronomical unit and Jupiter equatorial radius", () => {
    expect(AU_KM).toBeCloseTo(149597870.7, 1);
    expect(JUPITER_EQUATORIAL_RADIUS_KM).toBe(71492);
    expect(RAD2ARCSEC).toBeCloseTo(206264.806, 2);
  });
});
