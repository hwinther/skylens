/**
 * Pure EME (moonbounce) math. Like planets.test.ts, astronomy-engine is a deterministic function of the
 * instant with no external state, so these hold at a FIXED date with loose real-world bounds plus
 * self-consistency (echo delay and path-loss re-derived from the module's own distance, distance
 * cross-checked against a direct Libration call).
 */

import * as Astro from "astronomy-engine";
import { moonEmeInfo, SPEED_OF_LIGHT_KM_S } from "@/ar/moon";

// A fixed instant, mid lunar-month (away from perigee) so the path-loss penalty is solidly positive;
// the Moon's geometry (distance, libration, the month's apsides) is fully determined by it.
const DATE = new Date("2026-07-20T00:00:00Z");

describe("moonEmeInfo — echo delay, apsides, path loss (fixed instant)", () => {
  const info = moonEmeInfo(DATE);

  it("gives a distance and echo delay in the Moon's real range", () => {
    expect(info.distanceKm).toBeGreaterThanOrEqual(356000);
    expect(info.distanceKm).toBeLessThanOrEqual(407000);
    expect(info.echoDelaySeconds).toBeGreaterThanOrEqual(2.37);
    expect(info.echoDelaySeconds).toBeLessThanOrEqual(2.71);
    // Round-trip echo delay is exactly 2 · distance / c.
    expect(info.echoDelaySeconds).toBe((2 * info.distanceKm) / SPEED_OF_LIGHT_KM_S);
  });

  it("finds the next perigee closer than the next apogee, both in the future", () => {
    expect(info.nextPerigee.km).toBeLessThan(info.nextApogee.km);
    expect(info.nextPerigee.km).toBeGreaterThanOrEqual(356000);
    expect(info.nextPerigee.km).toBeLessThanOrEqual(371000);
    expect(info.nextApogee.km).toBeGreaterThanOrEqual(404000);
    expect(info.nextApogee.km).toBeLessThanOrEqual(407000);
    expect(info.nextPerigee.date.getTime()).toBeGreaterThan(DATE.getTime());
    expect(info.nextApogee.date.getTime()).toBeGreaterThan(DATE.getTime());
  });

  it("quotes a non-negative one-way path-loss penalty, self-consistent with distance vs perigee", () => {
    expect(info.pathLossPenaltyDb).toBeGreaterThanOrEqual(0);
    expect(info.pathLossPenaltyDb).toBe(20 * Math.log10(info.distanceKm / info.nextPerigee.km));
    // At the current perigee distance the penalty vanishes (log10(1) = 0).
    const atPerigee = 20 * Math.log10(info.nextPerigee.km / info.nextPerigee.km);
    expect(atPerigee).toBeCloseTo(0, 10);
  });

  it("matches a direct Libration reduction for distance and angular diameter", () => {
    const lib = Astro.Libration(Astro.MakeTime(DATE));
    expect(info.distanceKm).toBe(lib.dist_km);
    expect(info.librationLatDeg).toBe(lib.elat);
    expect(info.librationLonDeg).toBe(lib.elon);
    expect(info.angularDiameterDeg).toBeGreaterThanOrEqual(0.49);
    expect(info.angularDiameterDeg).toBeLessThanOrEqual(0.57);
  });

  // Regression: just after a perigee the Moon is nearer than the NEXT perigee (a month out), so the
  // raw ratio dips below 1 and 20·log10 goes negative. The penalty must floor at 0, never render "-0.0".
  it("floors the path-loss penalty at 0 in the post-perigee window", () => {
    const postPerigee = moonEmeInfo(new Date("2026-07-14T22:00:00Z"));
    const raw = 20 * Math.log10(postPerigee.distanceKm / postPerigee.nextPerigee.km);
    expect(raw).toBeLessThan(0); // the exact case that exposed the bug
    expect(postPerigee.pathLossPenaltyDb).toBe(0); // …clamped, not negative
  });
});
