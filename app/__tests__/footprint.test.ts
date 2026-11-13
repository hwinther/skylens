/**
 * Satellite coverage footprint (src/ar/footprint): the central-angle formula against known values, the
 * ring geometry (every vertex at the footprint radius from the sub-point), and the map-drawable shapes:
 * a plain circle, one cut by the antimeridian, and ones enclosing the north / south pole.
 */

import {
  buildSatrecs,
  centralAngleBetweenDeg,
  destinationPoint,
  footprint,
  footprintCentralAngleDeg,
  footprintRadiusKm,
  FOOTPRINT_EARTH_RADIUS_KM,
  MAP_MAX_LAT,
  propagateAll,
  type LatLon,
} from "@/ar";
import type { SatelliteDto } from "@/api/types";

const ISS_ALT_KM = 420;
const GEO_ALT_KM = 35786;

/** Ray-casting point-in-polygon in plain lat/lon (the footprint's own planar clip space). */
function inPolygon(pt: LatLon, ring: LatLon[]): boolean {
  const [y, x] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inAny = (pt: LatLon, rings: LatLon[][]) => rings.some((r) => inPolygon(pt, r));
const allVertices = (rings: LatLon[][]) => rings.flat();

describe("footprintCentralAngleDeg / footprintRadiusKm — known values", () => {
  it("ISS at ~420 km: λ ≈ 20.3°, radius ≈ 2,250 km", () => {
    expect(footprintCentralAngleDeg(ISS_ALT_KM)).toBeCloseTo(20.27, 1);
    const r = footprintRadiusKm(ISS_ALT_KM);
    expect(r).toBeGreaterThan(2200);
    expect(r).toBeLessThan(2300);
  });

  it("GEO: λ ≈ 81.3° (a geostationary satellite sees most of a hemisphere)", () => {
    expect(footprintCentralAngleDeg(GEO_ALT_KM)).toBeCloseTo(81.3, 1);
  });

  it("matches arccos(R / (R + h)) at 0° elevation", () => {
    for (const h of [200, 800, 1200, 20200]) {
      const expected = (Math.acos(FOOTPRINT_EARTH_RADIUS_KM / (FOOTPRINT_EARTH_RADIUS_KM + h)) * 180) / Math.PI;
      expect(footprintCentralAngleDeg(h)).toBeCloseTo(expected, 9);
    }
  });

  it("shrinks with an elevation mask and grows with height", () => {
    expect(footprintCentralAngleDeg(ISS_ALT_KM, 10)).toBeLessThan(footprintCentralAngleDeg(ISS_ALT_KM));
    expect(footprintCentralAngleDeg(800)).toBeGreaterThan(footprintCentralAngleDeg(ISS_ALT_KM));
    // ISS with a 10° mask: λ = arccos(R cos10°/(R+h)) − 10° ≈ 12.4°.
    expect(footprintCentralAngleDeg(ISS_ALT_KM, 10)).toBeCloseTo(12.4, 0);
  });

  it("is 0 for an unusable height", () => {
    expect(footprintCentralAngleDeg(0)).toBe(0);
    expect(footprintCentralAngleDeg(-5)).toBe(0);
    expect(footprintCentralAngleDeg(Number.NaN)).toBe(0);
    expect(footprint(10, 10, 0)).toBeNull();
    expect(footprint(Number.NaN, 10, 400)).toBeNull();
  });
});

describe("destinationPoint", () => {
  it("goes north / east along the equator by the angle", () => {
    const [lat, lon] = destinationPoint(0, 0, 0, 10);
    expect(lat).toBeCloseTo(10, 9);
    expect(lon).toBeCloseTo(0, 9);
    const [lat2, lon2] = destinationPoint(0, 0, 90, 10);
    expect(lat2).toBeCloseTo(0, 9);
    expect(lon2).toBeCloseTo(10, 9);
  });

  it("lands exactly the central angle away, any bearing", () => {
    for (const b of [0, 33, 120, 250, 359]) {
      const p = destinationPoint(48, -30, b, 20.27);
      expect(centralAngleBetweenDeg([48, -30], p)).toBeCloseTo(20.27, 6);
    }
  });
});

describe("footprint — plain circle", () => {
  const fp = footprint(51.77, 7.69, ISS_ALT_KM)!; // the ISS over central Europe

  it("is one polygon and one closed outline, all vertices on the circle", () => {
    expect(fp.polygons).toHaveLength(1);
    expect(fp.outline).toHaveLength(1);
    const line = fp.outline[0];
    expect(line[0][0]).toBeCloseTo(line[line.length - 1][0], 9);
    expect(line[0][1]).toBeCloseTo(line[line.length - 1][1], 9);
    for (const p of fp.polygons[0]) {
      expect(centralAngleBetweenDeg([51.77, 7.69], p)).toBeCloseTo(fp.centralAngleDeg, 6);
    }
    expect(fp.radiusKm).toBeCloseTo(footprintRadiusKm(ISS_ALT_KM), 6);
  });

  it("contains the sub-point and Oslo, not New York", () => {
    expect(inAny([51.77, 7.69], fp.polygons)).toBe(true);
    expect(inAny([59.9, 10.75], fp.polygons)).toBe(true);
    expect(inAny([40.7, -74], fp.polygons)).toBe(false);
  });

  it("honours the segment count", () => {
    expect(footprint(0, 0, ISS_ALT_KM, { segments: 24 })!.polygons[0]).toHaveLength(24);
  });
});

describe("footprint — across the antimeridian", () => {
  const fp = footprint(-10, 175, ISS_ALT_KM)!;

  it("splits into an east and a west piece, every vertex inside [-180, 180]", () => {
    expect(fp.polygons).toHaveLength(2);
    for (const [, lon] of allVertices(fp.polygons)) {
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThanOrEqual(180);
    }
    const centres = fp.polygons.map((r) => r.reduce((s, p) => s + p[1], 0) / r.length).sort((a, b) => a - b);
    expect(centres[0]).toBeLessThan(0); // the piece past the seam, drawn at the map's west edge
    expect(centres[1]).toBeGreaterThan(0);
  });

  it("covers points on both sides of the seam, and not the far side of the world", () => {
    expect(inAny([-10, 179.5], fp.polygons)).toBe(true);
    expect(inAny([-10, -175], fp.polygons)).toBe(true); // 10° east of the sub-point, across the seam
    expect(inAny([-10, 0], fp.polygons)).toBe(false);
  });

  it("splits the outline at the seam with exact ±180 end points (no line across the map)", () => {
    expect(fp.outline).toHaveLength(2);
    for (const run of fp.outline) {
      for (let i = 1; i < run.length; i++) expect(Math.abs(run[i][1] - run[i - 1][1])).toBeLessThan(180);
      const ends = [run[0][1], run[run.length - 1][1]];
      expect(ends.every((l) => Math.abs(Math.abs(l) - 180) < 1e-9)).toBe(true);
    }
  });

  it("also splits a sub-point just west of the seam", () => {
    const west = footprint(30, -178, ISS_ALT_KM)!;
    expect(west.polygons).toHaveLength(2);
    expect(inAny([30, 179], west.polygons)).toBe(true);
    expect(inAny([30, -170], west.polygons)).toBe(true);
  });
});

describe("footprint — over a pole", () => {
  it("closes over the north pole when the circle encloses it", () => {
    const fp = footprint(80, 30, ISS_ALT_KM)!; // λ ≈ 20.3° > 10° to the pole
    const verts = allVertices(fp.polygons);
    // Wraps the whole map width and reaches the Mercator cap.
    expect(Math.min(...verts.map((p) => p[1]))).toBeCloseTo(-180, 6);
    expect(Math.max(...verts.map((p) => p[1]))).toBeCloseTo(180, 6);
    expect(Math.max(...verts.map((p) => p[0]))).toBeCloseTo(MAP_MAX_LAT, 6);
    for (const [lat] of verts) expect(Math.abs(lat)).toBeLessThanOrEqual(MAP_MAX_LAT);
    // Every longitude near the pole is covered; the far side of the circle's rim is not.
    for (const lon of [-170, -90, 0, 90, 170]) expect(inAny([84, lon], fp.polygons)).toBe(true);
    expect(inAny([60, 30], fp.polygons)).toBe(true); // 20° south of the sub-point: inside
    expect(inAny([55, 30], fp.polygons)).toBe(false); // 25° south: outside
    // 18° over the pole: inside (< λ ≈ 20.3°), on both sides of where the two clipped pieces meet.
    expect(inAny([82, -155], fp.polygons)).toBe(true);
    expect(inAny([82, -145], fp.polygons)).toBe(true);
    expect(inAny([75, -150], fp.polygons)).toBe(false); // 25° over the pole: outside
  });

  it("closes over the south pole for a southern sub-point", () => {
    const fp = footprint(-78, -120, 800)!;
    const verts = allVertices(fp.polygons);
    expect(Math.min(...verts.map((p) => p[0]))).toBeCloseTo(-MAP_MAX_LAT, 6);
    for (const lon of [-179, -60, 0, 60, 179]) expect(inAny([-84, lon], fp.polygons)).toBe(true);
    expect(inAny([-40, -120], fp.polygons)).toBe(false);
  });

  it("does not add a pole cap when the circle stays clear of the pole", () => {
    const fp = footprint(60, 10, ISS_ALT_KM)!; // 60 + 20.3 < 90
    expect(fp.polygons).toHaveLength(1);
    expect(inAny([84, 10], fp.polygons)).toBe(false);
  });

  it("survives a sub-point exactly on the pole", () => {
    const fp = footprint(90, 0, ISS_ALT_KM)!;
    expect(fp.polygons.length).toBeGreaterThan(0);
    for (const [lat, lon] of allVertices(fp.polygons)) {
      expect(Number.isFinite(lat) && Number.isFinite(lon)).toBe(true);
    }
    expect(inAny([80, 123], fp.polygons)).toBe(true);
  });
});

describe("footprint — GEO", () => {
  it("covers ~81° around the sub-point", () => {
    const fp = footprint(0, 0, GEO_ALT_KM)!;
    expect(fp.polygons).toHaveLength(1);
    expect(inAny([0, 80], fp.polygons)).toBe(true);
    expect(inAny([0, 83], fp.polygons)).toBe(false);
    expect(inAny([59.9, 10.75], fp.polygons)).toBe(true);
  });

  it("wraps when it reaches past the seam", () => {
    const fp = footprint(0, 150, GEO_ALT_KM)!;
    expect(fp.polygons).toHaveLength(2);
    expect(inAny([0, -150], fp.polygons)).toBe(true); // 60° east of the sub-point
    expect(inAny([0, -100], fp.polygons)).toBe(false); // 110° east
  });
});

describe("footprint ↔ propagation consistency", () => {
  it("the observer of a real ISS pass (20° up) lies inside that instant's footprint", () => {
    const omm = {
      OBJECT_NAME: "ISS (ZARYA)",
      OBJECT_ID: "1998-067A",
      EPOCH: "2026-07-11T07:33:23.712192",
      MEAN_MOTION: 15.48978902,
      ECCENTRICITY: 0.00066885,
      INCLINATION: 51.6302,
      RA_OF_ASC_NODE: 180.6822,
      ARG_OF_PERICENTER: 282.4935,
      MEAN_ANOMALY: 77.5305,
      EPHEMERIS_TYPE: 0,
      CLASSIFICATION_TYPE: "U",
      NORAD_CAT_ID: 25544,
      ELEMENT_SET_NO: 999,
      REV_AT_EPOCH: 57549,
      BSTAR: 0.00010843416,
      MEAN_MOTION_DOT: 5.525e-5,
      MEAN_MOTION_DDOT: 0,
    } as unknown as SatelliteDto["omm"];
    const observer = { lat: 59.9, lon: 10.7 };
    const v = propagateAll(
      buildSatrecs([{ noradId: 25544, name: "ISS (ZARYA)", group: "stations", omm }]),
      observer,
      new Date("2026-07-11T21:52:23.712Z"),
    )[0];
    const fp = footprint(v.subLat, v.subLon, v.altKm!)!;
    expect(inAny([observer.lat, observer.lon], fp.polygons)).toBe(true);
    // ...and the 0° footprint is larger than the 20° one, which the observer sits right at the edge of.
    const at20 = footprintCentralAngleDeg(v.altKm!, 20);
    const dist = centralAngleBetweenDeg([v.subLat, v.subLon], [observer.lat, observer.lon]);
    expect(Math.abs(dist - at20)).toBeLessThan(0.6);
  });
});
