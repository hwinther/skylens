/**
 * Pure fixed-radio-source astronomy. Like the planet tests, astronomy-engine is a deterministic
 * function of (date, observer) with no external state, so these assertions are solid and
 * cross-checkable against JPL Horizons. Two kinds of check:
 *  1. Reference/geometry pins — the visible sources' elevation and each source's transit altitude at a
 *     FIXED instant, guarding the DefineStar→Equator→Horizon wiring against a regression.
 *  2. Self-consistency — a source `computeRadioSky` returns must match a parallel, independent
 *     astronomy-engine reduction (a DIFFERENT star slot), so the module can't quietly diverge and the
 *     redefine-before-read slot discipline is proven.
 *
 * All pinned numbers were captured from the installed astronomy-engine at the instant below.
 */

import * as Astro from "astronomy-engine";
import {
  computeRadioSky,
  HYDROGEN_LINE_MHZ,
  nextRadioTransit,
  RADIO_SOURCES,
  type RadioSource,
} from "@/ar/radioSky";

// Oslo-ish, late evening. At this instant Sgr A*, Cas A and Cyg A are up; Tau A (the Crab) is below
// the horizon — so the "returns all four incl. below-horizon" contract and the reduction both get
// exercised on real, mixed data.
const OBSERVER = { lat: 59.9, lon: 10.7, alt: 100 };
const DATE = new Date("2026-07-14T22:00:00Z");

const source = (key: string): RadioSource => RADIO_SOURCES.find((s) => s.key === key)!;

describe("computeRadioSky — the four fixed sources at a pinned Oslo instant", () => {
  const views = computeRadioSky(OBSERVER, DATE);
  const byKey = new Map(views.map((v) => [v.key, v]));

  it("returns all four sources (incl. below-horizon) with in-range, finite az/el", () => {
    expect(views.map((v) => v.key).sort()).toEqual(["casA", "cygA", "sgrA", "tauA"]);
    for (const v of views) {
      expect(Number.isFinite(v.azimuthDeg)).toBe(true);
      expect(v.azimuthDeg).toBeGreaterThanOrEqual(0);
      expect(v.azimuthDeg).toBeLessThan(360);
      expect(v.elevationDeg).toBeGreaterThanOrEqual(-90);
      expect(v.elevationDeg).toBeLessThanOrEqual(90);
    }
  });

  it("matches an independent astronomy-engine reduction for Cas A (proves the reduction + slot reuse)", () => {
    // Re-derive Cas A directly through a DIFFERENT slot (Star5) with the SAME of-date+aberration Equator
    // and "normal"-refraction Horizon args the module uses. Equality to the module output proves both
    // the reduction path and that redefining before reading keeps slots independent.
    const casA = source("casA");
    const obs = new Astro.Observer(OBSERVER.lat, OBSERVER.lon, OBSERVER.alt);
    Astro.DefineStar(Astro.Body.Star5, casA.raHours, casA.decDeg, casA.distanceLy);
    const eq = Astro.Equator(Astro.Body.Star5, DATE, obs, true, true);
    const hor = Astro.Horizon(DATE, obs, eq.ra, eq.dec, "normal");
    // Horizon already returns azimuth in [0, 360), so the module's normalizeAzimuth is a no-op here.
    const v = byKey.get("casA")!;
    expect(v.azimuthDeg).toBeCloseTo(hor.azimuth, 6);
    expect(v.elevationDeg).toBeCloseTo(hor.altitude, 6);
  });

  it("places Cas A high (near-circumpolar from lat 59.9°) and Tau A below the horizon", () => {
    // Cas A (Dec +58.8°) transits within ~1° of the zenith from lat 59.9°, so it is well up at this
    // instant (captured el ≈ 52.8°). Tau A (Dec +22°) is on the far side of the sky and below the
    // horizon here (captured el ≈ −7.1°) — proving computeRadioSky returns below-horizon sources too.
    expect(byKey.get("casA")!.elevationDeg).toBeGreaterThan(0);
    expect(byKey.get("casA")!.elevationDeg).toBeCloseTo(52.8, 0);
    expect(byKey.get("tauA")!.elevationDeg).toBeLessThan(0);
  });

  it("carries the fixed RA/Dec and kind straight through", () => {
    const casA = byKey.get("casA")!;
    expect(casA.raHours).toBe(source("casA").raHours);
    expect(casA.decDeg).toBe(source("casA").decDeg);
    expect(casA.kind).toBe("Supernova remnant");
  });

  it("is independent of call order / interleaving (redefine-before-read)", () => {
    // Recompute after a nextRadioTransit call (which redefines slots for a different source). If the
    // module ever read a stale slot, these would drift.
    const first = computeRadioSky(OBSERVER, DATE);
    nextRadioTransit(source("cygA"), OBSERVER, DATE);
    const second = computeRadioSky(OBSERVER, DATE);
    const secondByKey = new Map(second.map((v) => [v.key, v]));
    for (const v of first) {
      const w = secondByKey.get(v.key)!;
      expect(w.azimuthDeg).toBe(v.azimuthDeg);
      expect(w.elevationDeg).toBe(v.elevationDeg);
    }
  });
});

describe("nextRadioTransit — culmination of a fixed source", () => {
  it("gives Cas A a near-zenith transit (~89°) after the input date", () => {
    // Cas A culminates at 90 − |59.9 − 58.815| ≈ 88.9°; astronomy-engine's refracted value is ≈89.06°.
    const t = nextRadioTransit(source("casA"), OBSERVER, DATE)!;
    expect(t).not.toBeNull();
    expect(t.date.getTime()).toBeGreaterThan(DATE.getTime());
    expect(t.altitudeDeg).toBeGreaterThan(85);
    expect(t.altitudeDeg).toBeLessThanOrEqual(90);
  });

  it("gives Sgr A* a LOW transit from Norway (barely rises: alt < 5°, still > 0°)", () => {
    // Sgr A* (Dec −29°) culminates at 90 − |59.9 − (−29.0078)| ≈ 1.09°; refracted value ≈1.44°. It DOES
    // clear the horizon (just), so the result is non-null with a small positive altitude.
    const t = nextRadioTransit(source("sgrA"), OBSERVER, DATE)!;
    expect(t).not.toBeNull();
    expect(t.altitudeDeg).toBeGreaterThan(0);
    expect(t.altitudeDeg).toBeLessThan(5);
    expect(t.altitudeDeg).toBeGreaterThanOrEqual(-90);
    expect(t.altitudeDeg).toBeLessThanOrEqual(90);
  });

  it("returns null for a source that never rises (guarded latitude)", () => {
    // From the far north (lat 80°), Sgr A* at Dec −29° can never rise: 90 − |80 − (−29)| = −19° < 0.
    const t = nextRadioTransit(source("sgrA"), { lat: 80, lon: 10.7, alt: 0 }, DATE);
    expect(t).toBeNull();
  });
});

describe("HYDROGEN_LINE_MHZ — the 21 cm rest frequency", () => {
  it("is the neutral-hydrogen line rest frequency", () => {
    expect(HYDROGEN_LINE_MHZ).toBe(1420.405751);
  });
});

describe("RADIO_SOURCES — the tracked set", () => {
  it("is the four sources in a fixed order with sane fields", () => {
    expect(RADIO_SOURCES.map((s) => s.key)).toEqual(["sgrA", "casA", "cygA", "tauA"]);
    expect(RADIO_SOURCES.map((s) => s.short)).toEqual(["Sgr A*", "Cas A", "Cyg A", "Tau A"]);
    for (const s of RADIO_SOURCES) {
      expect(s.raHours).toBeGreaterThanOrEqual(0);
      expect(s.raHours).toBeLessThan(24);
      expect(s.decDeg).toBeGreaterThanOrEqual(-90);
      expect(s.decDeg).toBeLessThanOrEqual(90);
      expect(s.distanceLy).toBeGreaterThanOrEqual(1); // DefineStar's minimum
      expect(s.blurb.length).toBeGreaterThan(0);
    }
  });
});
