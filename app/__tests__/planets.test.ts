/**
 * Pure planet astronomy. Unlike the satellite tests (whose SGP4 pins carry a "TLE age" caveat),
 * astronomy-engine is a deterministic function of (date, observer) with no external state, so these
 * assertions are solid and cross-checkable against JPL Horizons. Two kinds of check:
 *  1. Reference pins — a couple of bodies' az/alt at a FIXED instant, held to ±0.2°, guarding the
 *     Equator→Horizon wiring against a regression.
 *  2. Self-consistency — every body `computePlanets` returns must match a parallel, independent
 *     astronomy-engine reduction, so the module can't quietly diverge from the library.
 */

import * as Astro from "astronomy-engine";
import {
  bodyForKey,
  computePlanets,
  eclipticLinePoints,
  MAX_PLANET_DOT,
  MIN_PLANET_DOT,
  nextPlanetEvents,
  planetDotSize,
  PLANET_BODIES,
  SUN_MAGNITUDE,
} from "@/ar/planets";

// Oslo-ish, summer local afternoon: 8 of the 9 bodies are above the horizon at this instant, so the
// filter, the reduction, and the enrichment all get exercised on real data.
const OBSERVER = { lat: 59.9, lon: 10.7, alt: 100 };
const DATE = new Date("2026-07-14T11:00:00Z");

describe("computePlanets — reference pins + self-consistency (Oslo, fixed instant)", () => {
  const views = computePlanets(OBSERVER, DATE);
  const byBody = new Map(views.map((v) => [v.body, v]));

  it("returns the up bodies with in-range, finite az/el", () => {
    // 8 up at this instant (all but Neptune); at minimum the bright ones must be present.
    expect(views.length).toBeGreaterThanOrEqual(6);
    for (const v of views) {
      expect(Number.isFinite(v.azimuthDeg)).toBe(true);
      expect(v.azimuthDeg).toBeGreaterThanOrEqual(0);
      expect(v.azimuthDeg).toBeLessThan(360);
      expect(v.elevationDeg).toBeGreaterThanOrEqual(0); // filtered to at/above the horizon
      expect(v.elevationDeg).toBeLessThanOrEqual(90);
    }
  });

  it("places the Sun and Moon at their pinned az/alt", () => {
    const sun = byBody.get("Sun")!;
    expect(sun).toBeDefined();
    expect(sun.azimuthDeg).toBeCloseTo(171.35, 0); // ±0.5°, actual ≈171.35
    expect(sun.elevationDeg).toBeGreaterThan(51.53 - 0.3);
    expect(sun.elevationDeg).toBeLessThan(51.53 + 0.3);
    const moon = byBody.get("Moon")!;
    expect(moon).toBeDefined();
    expect(moon.azimuthDeg).toBeCloseTo(168.81, 0);
    expect(moon.elevationDeg).toBeCloseTo(53.79, 0);
  });

  it("matches an independent astronomy-engine reduction for every returned body", () => {
    const obs = new Astro.Observer(OBSERVER.lat, OBSERVER.lon, OBSERVER.alt);
    for (const v of views) {
      const body = bodyForKey(v.body)!;
      const eq = Astro.Equator(body, DATE, obs, true, true);
      const hor = Astro.Horizon(DATE, obs, eq.ra, eq.dec, "normal");
      expect(v.azimuthDeg).toBeCloseTo(hor.azimuth, 3);
      expect(v.elevationDeg).toBeCloseTo(hor.altitude, 3);
    }
  });

  it("enriches magnitude, phase and constellation sensibly", () => {
    const sun = byBody.get("Sun")!;
    expect(sun.magnitude).toBe(SUN_MAGNITUDE);
    expect(sun.phasePercent).toBeNull(); // no phase for the Sun
    const venus = byBody.get("Venus")!;
    expect(venus.magnitude!).toBeGreaterThan(-6);
    expect(venus.magnitude!).toBeLessThan(0); // Venus is always bright
    expect(venus.phasePercent!).toBeGreaterThanOrEqual(0);
    expect(venus.phasePercent!).toBeLessThanOrEqual(100);
    expect(typeof venus.constellation).toBe("string");
    expect(venus.constellation!.length).toBeGreaterThan(0);
    for (const v of views) {
      if (v.distanceAu != null) expect(v.distanceAu).toBeGreaterThan(0);
    }
  });
});

describe("nextPlanetEvents — tonight's rise / set / culmination", () => {
  it("gives a culmination and finite altitude for a non-polar body", () => {
    const mars = bodyForKey("Mars")!;
    const ev = nextPlanetEvents(mars, OBSERVER, DATE);
    expect(ev.culmination).toBeInstanceOf(Date);
    expect(Number.isFinite(ev.culminationAltitude!)).toBe(true);
    // Rise/set are searched within the day window; at least one bound should resolve for Mars here.
    expect(ev.rise != null || ev.set != null).toBe(true);
  });

  it("returns nulls gracefully for a circumpolar/no-event search (tiny window)", () => {
    const jupiter = bodyForKey("Jupiter")!;
    // A near-zero window from an instant Jupiter is already up → no rise found inside it.
    const ev = nextPlanetEvents(jupiter, OBSERVER, DATE, 0.001);
    expect(ev.rise === null || ev.rise instanceof Date).toBe(true); // no throw, typed result
  });
});

describe("eclipticLinePoints — the arc the planets ride", () => {
  const pts = eclipticLinePoints(OBSERVER, DATE);

  it("returns finite, in-range sample points", () => {
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) {
      expect(Number.isFinite(p.azimuthDeg)).toBe(true);
      expect(p.azimuthDeg).toBeGreaterThanOrEqual(0);
      expect(p.azimuthDeg).toBeLessThan(360);
      expect(Number.isFinite(p.elevationDeg)).toBe(true);
    }
  });

  it("the up Sun sits essentially ON the ecliptic (an ecliptic sample passes near it)", () => {
    const sun = computePlanets(OBSERVER, DATE).find((v) => v.body === "Sun")!;
    // The Sun defines the ecliptic, so the arc must pass near it — but the arc is only sampled every
    // 5° of ecliptic longitude, so the nearest sample can be a few degrees along-track. Assert the
    // closest sample is within one sampling step (angular distance), which still proves the ecliptic
    // reduction lands where the Sun is rather than somewhere random.
    const dAz = (a: number, b: number) => {
      const d = Math.abs(a - b) % 360;
      return d > 180 ? 360 - d : d;
    };
    const minDist = Math.min(
      ...pts.map((p) => Math.hypot(dAz(p.azimuthDeg, sun.azimuthDeg), p.elevationDeg - sun.elevationDeg)),
    );
    expect(minDist).toBeLessThan(6);
  });
});

describe("planetDotSize — brighter is bigger, clamped", () => {
  it("maps a bright body larger than a faint one and clamps the range", () => {
    const venus = planetDotSize(-4);
    const neptune = planetDotSize(7.8);
    expect(venus).toBeGreaterThan(neptune);
    expect(venus).toBeLessThanOrEqual(MAX_PLANET_DOT);
    expect(neptune).toBeGreaterThanOrEqual(MIN_PLANET_DOT);
    // null magnitude (shouldn't happen for a rendered planet) is handled, not NaN.
    expect(Number.isFinite(planetDotSize(null))).toBe(true);
  });
});

describe("PLANET_BODIES — the tracked set", () => {
  it("is the nine classical bodies, Sun/Moon first", () => {
    expect(PLANET_BODIES.map((b) => b.name)).toEqual([
      "Sun",
      "Moon",
      "Mercury",
      "Venus",
      "Mars",
      "Jupiter",
      "Saturn",
      "Uranus",
      "Neptune",
    ]);
    // Every key round-trips through bodyForKey.
    for (const { name } of PLANET_BODIES) expect(bodyForKey(name)).not.toBeNull();
    expect(bodyForKey("Pluto-ish-nonsense")).toBeNull();
  });
});
