/**
 * Orbit class from OMM mean elements (LEO / MEO / GEO / IGSO / HEO), the derived period and apogee/
 * perigee altitudes, and the text the satellite detail sheet shows.
 */

import {
  formatOrbitAltitudeKm,
  formatOrbitPeriod,
  formatOrbitSummary,
  IGSO_MIN_INCLINATION_DEG,
  orbitInfo,
} from "@/ar/orbitClass";

const omm = (MEAN_MOTION: number, ECCENTRICITY: number, INCLINATION = 0) => ({
  MEAN_MOTION,
  ECCENTRICITY,
  INCLINATION,
});

describe("orbitInfo", () => {
  it("puts the ISS in LEO at ~93 min and ~420 km", () => {
    const o = orbitInfo(omm(15.5, 0.0005, 51.6))!;
    expect(o.class).toBe("LEO");
    expect(o.periodMin).toBeCloseTo(92.9, 1);
    expect(o.perigeeKm).toBeGreaterThan(400);
    expect(o.apogeeKm).toBeLessThan(440);
  });

  it("puts a GPS satellite in MEO at ~718 min and ~20 180 km", () => {
    const o = orbitInfo(omm(2.0056, 0.01, 55))!;
    expect(o.class).toBe("MEO");
    expect(o.periodMin).toBeCloseTo(718, 0);
    expect(Math.abs((o.apogeeKm + o.perigeeKm) / 2 - 20_180)).toBeLessThan(30);
  });

  it("puts a geostationary weather satellite in GEO at ~35 786 km", () => {
    const o = orbitInfo(omm(1.0027, 0.0002, 0.05))!;
    expect(o.class).toBe("GEO");
    expect(Math.abs((o.apogeeKm + o.perigeeKm) / 2 - 35_786)).toBeLessThan(20);
  });

  it("keeps a drifted geostationary satellite (i ≈ 12°) in GEO", () => {
    expect(orbitInfo(omm(1.0027, 0.0003, 12))!.class).toBe("GEO");
  });

  it("calls an inclined geosynchronous BeiDou IGSO", () => {
    expect(orbitInfo(omm(1.0027, 0.005, 55))!.class).toBe("IGSO");
  });

  it("splits GEO from IGSO at 20° inclination", () => {
    expect(orbitInfo(omm(1.0027, 0.001, IGSO_MIN_INCLINATION_DEG))!.class).toBe("GEO");
    expect(orbitInfo(omm(1.0027, 0.001, IGSO_MIN_INCLINATION_DEG + 0.01))!.class).toBe("IGSO");
  });

  it("calls a slightly eccentric geosynchronous satellite GEO, not MEO", () => {
    expect(orbitInfo(omm(1.0, 0.08, 2))!.class).toBe("GEO");
  });

  it("calls a Molniya HEO with its perigee far below its apogee", () => {
    const o = orbitInfo(omm(2.006, 0.72, 63.4))!;
    expect(o.class).toBe("HEO");
    expect(o.perigeeKm).toBeLessThan(2_000);
    expect(o.apogeeKm).toBeGreaterThan(38_000);
    expect(o.apogeeKm).toBeLessThan(41_000);
  });

  it("calls an eccentric geosynchronous (Tundra-like) orbit HEO before GEO/IGSO", () => {
    expect(orbitInfo(omm(1.0027, 0.27, 63.4))!.class).toBe("HEO");
  });

  it("draws the LEO/MEO line at a 128-minute period", () => {
    expect(orbitInfo(omm(1440 / 127.9, 0.001))!.class).toBe("LEO");
    expect(orbitInfo(omm(1440 / 128, 0.001))!.class).toBe("MEO");
  });

  it("returns null without a usable mean motion", () => {
    expect(orbitInfo(omm(0, 0.001))).toBeNull();
    expect(orbitInfo(omm(-1, 0.001))).toBeNull();
    expect(orbitInfo(omm(Number.NaN, 0.001))).toBeNull();
    expect(orbitInfo(omm(Number.POSITIVE_INFINITY, 0.001))).toBeNull();
    expect(orbitInfo({})).toBeNull();
    expect(orbitInfo(null)).toBeNull();
  });
});

describe("orbit text", () => {
  it("formats the period as minutes under 2 h, else hours and minutes", () => {
    expect(formatOrbitPeriod(92.9)).toBe("93 min");
    expect(formatOrbitPeriod(119.4)).toBe("119 min");
    expect(formatOrbitPeriod(120)).toBe("2 h 0 min");
    expect(formatOrbitPeriod(718)).toBe("11 h 58 min");
  });

  it("rounds altitudes to 3 significant figures with a space as thousands separator", () => {
    expect(formatOrbitAltitudeKm(424.6)).toBe("425");
    expect(formatOrbitAltitudeKm(20_189)).toBe("20 200");
    expect(formatOrbitAltitudeKm(1_234)).toBe("1 230");
    expect(formatOrbitAltitudeKm(-3)).toBe("0");
  });

  it("shows one altitude for a near-circular orbit and a range for an eccentric one", () => {
    expect(formatOrbitSummary(orbitInfo(omm(15.5, 0.0005))!)).toMatch(/^LEO · 4\d\d km · 93 min$/);
    expect(formatOrbitSummary(orbitInfo(omm(2.0056, 0.01))!)).toBe("MEO · 20 200 km · 11 h 58 min");
    expect(formatOrbitSummary(orbitInfo(omm(1.0027, 0.0002, 0.05))!)).toBe("GEO · 35 800 km · 23 h 56 min");
    expect(formatOrbitSummary(orbitInfo(omm(1.0027, 0.005, 55))!)).toBe("IGSO · 35 800 km · 23 h 56 min");
    expect(formatOrbitSummary(orbitInfo(omm(2.006, 0.72, 63.4))!)).toMatch(/^HEO · [\d ]+–[\d ]+ km · 11 h 58 min$/);
  });
});
