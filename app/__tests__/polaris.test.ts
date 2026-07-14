/**
 * Pure Polaris ephemeris + azimuth-trim solver. Like the planet/radio tests, astronomy-engine is a
 * deterministic function of (date, observer) with no external state, so these hold at a FIXED instant.
 * Two kinds of check:
 *  1. Reference geometry — Polaris's elevation ≈ the observer's latitude and its azimuth ≈ true north,
 *     the two facts the whole calibration leans on.
 *  2. Solver algebra — the trim solver recovers a synthetic compass error, is idempotent under an
 *     already-applied trim (trim-awareness), wraps to (−180, 180], and flags an elevation mismatch.
 *  3. Slot independence — Polaris (Star8) and the radio sources (Star1..4) never tread on each other.
 */

import { computeRadioSky } from "@/ar";
import {
  POLARIS,
  POLARIS_ELEVATION_TOLERANCE_DEG,
  polarisAltAz,
  solveAzimuthTrim,
} from "@/ar/polaris";

// Oslo-ish, late evening. Polaris is near-fixed, so the instant barely matters — but pin it anyway.
const OBSERVER = { lat: 59.9, lon: 10.7, alt: 100 };
const DATE = new Date("2026-07-15T22:00:00Z");

describe("polarisAltAz — the North Star as a calibration reference", () => {
  const polaris = polarisAltAz(OBSERVER, DATE);

  it("puts Polaris at an elevation ≈ the observer's latitude", () => {
    // The classic latitude-by-Polaris check. Within 1.5° covers refraction + Polaris's ~0.7° pole offset.
    expect(polaris.elevationDeg).toBeCloseTo(OBSERVER.lat, 0);
    expect(Math.abs(polaris.elevationDeg - OBSERVER.lat)).toBeLessThan(1.5);
  });

  it("puts Polaris within ~2° of true north (azimuth ≈ 0 / 360)", () => {
    const fromNorth = Math.min(polaris.azimuthDeg, 360 - polaris.azimuthDeg);
    expect(fromNorth).toBeLessThan(2);
  });
});

describe("solveAzimuthTrim — recovering a compass error from a Polaris sighting", () => {
  const polarisAz = polarisAltAz(OBSERVER, DATE).azimuthDeg;

  it("recovers a synthetic −7° sensor error as a +7° trim (currentTrim 0)", () => {
    // Sensor reads 7° low; with no trim applied the pose reports raw = polarisAz − 7.
    const { newTrimDeg } = solveAzimuthTrim({
      pointedAzimuthDeg: polarisAz - 7,
      currentTrimDeg: 0,
      observer: OBSERVER,
      date: DATE,
    });
    expect(newTrimDeg).toBeCloseTo(7, 2);
  });

  it("is trim-aware: the same physical error with currentTrim 3 still solves to +7", () => {
    // Same raw sensor error (−7°) but 3° of trim is already baked into the pose: pose reports P − 7 + 3.
    const { newTrimDeg } = solveAzimuthTrim({
      pointedAzimuthDeg: polarisAz - 7 + 3,
      currentTrimDeg: 3,
      observer: OBSERVER,
      date: DATE,
    });
    expect(newTrimDeg).toBeCloseTo(7, 2);
  });

  it("wraps a >180° raw difference back into (−180, 180]", () => {
    // Aim 200° away from Polaris (raw): the un-wrapped trim would be +200, which must wrap to −160.
    const { newTrimDeg } = solveAzimuthTrim({
      pointedAzimuthDeg: polarisAz - 200,
      currentTrimDeg: 0,
      observer: OBSERVER,
      date: DATE,
    });
    expect(newTrimDeg).toBeGreaterThan(-180);
    expect(newTrimDeg).toBeLessThanOrEqual(180);
    expect(newTrimDeg).toBeCloseTo(-160, 2);
  });

  it("reports the elevation error when a pointed elevation is given (sanity gate)", () => {
    const { polarisElevationDeg, elevationErrorDeg } = solveAzimuthTrim({
      pointedAzimuthDeg: polarisAz,
      currentTrimDeg: 0,
      observer: OBSERVER,
      date: DATE,
      pointedElevationDeg: polarisAltAz(OBSERVER, DATE).elevationDeg + 12,
    });
    expect(elevationErrorDeg).toBeCloseTo(12, 5);
    expect(elevationErrorDeg).toBeGreaterThan(POLARIS_ELEVATION_TOLERANCE_DEG);
    expect(polarisElevationDeg).toBeCloseTo(OBSERVER.lat, 0);
  });

  it("omits the elevation error when no pointed elevation is supplied", () => {
    const res = solveAzimuthTrim({
      pointedAzimuthDeg: polarisAz,
      currentTrimDeg: 0,
      observer: OBSERVER,
      date: DATE,
    });
    expect(res.elevationErrorDeg).toBeUndefined();
  });
});

describe("Star-slot independence — Polaris (Star8) vs radio sources (Star1..4)", () => {
  it("gives identical results whether or not computeRadioSky is interleaved", () => {
    const polarisFresh = polarisAltAz(OBSERVER, DATE);
    const radioFresh = computeRadioSky(OBSERVER, DATE);

    // Interleave the two modules, which redefine disjoint star slots. Neither must perturb the other.
    const polarisA = polarisAltAz(OBSERVER, DATE);
    const radioA = computeRadioSky(OBSERVER, DATE);
    const polarisB = polarisAltAz(OBSERVER, DATE);

    expect(polarisA).toEqual(polarisFresh);
    expect(polarisB).toEqual(polarisFresh);
    expect(radioA).toEqual(radioFresh);
  });
});

describe("POLARIS — the pinned star", () => {
  it("is Polaris's J2000 position, within 0.7° of the pole", () => {
    expect(90 - POLARIS.decDeg).toBeLessThan(0.8);
    expect(POLARIS.raHours).toBeGreaterThanOrEqual(0);
    expect(POLARIS.raHours).toBeLessThan(24);
  });
});
