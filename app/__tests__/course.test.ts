/**
 * Pure course-vector math: the physical lead distance, the great-circle destination it projects to, and
 * the per-domain aircraft/vessel wrappers (including the exclusions — AtoNs, missing/too-slow speed, no
 * heading). Great-circle offsets differ slightly from the naive 111 km/deg, so the geometric assertions
 * use toBeCloseTo with sensible tolerances rather than exact equality.
 */

import type { AircraftDto, VesselDto } from "@/api/types";
import {
  AIRCRAFT_LEAD_SECONDS,
  MIN_COURSE_SPEED_KN,
  SHIP_LEAD_SECONDS,
  aircraftCourseVector,
  courseVector,
  destinationPoint,
  leadDistanceKm,
  vesselCourseVector,
} from "@/components/webmap/course";

/** A minimal aircraft with sensible defaults; override the fields a case cares about. */
function aircraft(over: Partial<AircraftDto> = {}): AircraftDto {
  return { hex: "abc123", lat: 60, lon: 10, gs: 300, trk: 90, ...over };
}

/** A minimal vessel with sensible defaults; override the fields a case cares about. */
function vessel(over: Partial<VesselDto> = {}): VesselDto {
  return { mmsi: "123456789", kind: "ship", lat: 60, lon: 10, sog: 12, cog: 90, hdg: 90, ...over };
}

describe("leadDistanceKm", () => {
  it("60 kn for 1 h ≈ 111.12 km", () => {
    expect(leadDistanceKm(60, 3600)).toBeCloseTo(111.12, 2);
  });

  it("zero speed → zero distance", () => {
    expect(leadDistanceKm(0, 120)).toBe(0);
  });
});

describe("destinationPoint", () => {
  it("due north raises latitude ~1° with lon ~unchanged", () => {
    const [lat, lon] = destinationPoint(60, 10, 0, 111.195);
    expect(lat).toBeCloseTo(61, 1);
    expect(lon).toBeCloseTo(10, 6);
  });

  it("due east from the equator raises longitude, lat ≈ 0", () => {
    const [lat, lon] = destinationPoint(0, 0, 90, 111.195);
    expect(lat).toBeCloseTo(0, 6);
    expect(lon).toBeGreaterThan(0);
    expect(lon).toBeCloseTo(1, 1);
  });

  it("zero distance returns the same point", () => {
    const [lat, lon] = destinationPoint(60, 10, 42, 0);
    expect(lat).toBeCloseTo(60, 9);
    expect(lon).toBeCloseTo(10, 9);
  });

  it("normalizes longitude into [-180, 180] when crossing the antimeridian", () => {
    const [, lon] = destinationPoint(0, 179, 90, 300);
    expect(lon).toBeGreaterThanOrEqual(-180);
    expect(lon).toBeLessThanOrEqual(180);
    expect(lon).toBeLessThan(0); // wrapped past +180 to a negative longitude
  });
});

describe("courseVector", () => {
  it("returns null when speed is null", () => {
    expect(courseVector(60, 10, 90, null, AIRCRAFT_LEAD_SECONDS)).toBeNull();
  });

  it("returns null when speed is below MIN_COURSE_SPEED_KN", () => {
    expect(courseVector(60, 10, 90, MIN_COURSE_SPEED_KN - 0.01, AIRCRAFT_LEAD_SECONDS)).toBeNull();
  });

  it("returns null when bearing is null", () => {
    expect(courseVector(60, 10, null, 100, AIRCRAFT_LEAD_SECONDS)).toBeNull();
  });

  it("valid case: first point is the input, second is offset in the bearing direction (east)", () => {
    const v = courseVector(60, 10, 90, 300, AIRCRAFT_LEAD_SECONDS);
    expect(v).not.toBeNull();
    expect(v).toHaveLength(2);
    expect(v![0]).toEqual([60, 10]);
    expect(v![1][1]).toBeGreaterThan(10); // heading east → longitude increases
    expect(v![1][0]).toBeCloseTo(60, 1); // latitude roughly unchanged
  });
});

describe("aircraftCourseVector", () => {
  it("valid aircraft → 2 points", () => {
    const v = aircraftCourseVector(aircraft());
    expect(v).toHaveLength(2);
  });

  it("gs null → null", () => {
    expect(aircraftCourseVector(aircraft({ gs: null }))).toBeNull();
  });

  it("lat null → null", () => {
    expect(aircraftCourseVector(aircraft({ lat: null }))).toBeNull();
  });
});

describe("vesselCourseVector", () => {
  it("ship with sog/cog → 2 points", () => {
    const v = vesselCourseVector(vessel());
    expect(v).toHaveLength(2);
  });

  it("aton (even with sog/cog set) → null", () => {
    expect(vesselCourseVector(vessel({ kind: "aton" }))).toBeNull();
  });

  it("ship with sog 0 → null", () => {
    expect(vesselCourseVector(vessel({ sog: 0 }))).toBeNull();
  });

  it("ship with only hdg (cog null) → uses hdg → 2 points", () => {
    const v = vesselCourseVector(vessel({ cog: null, hdg: 90 }));
    expect(v).toHaveLength(2);
    expect(v![1][1]).toBeGreaterThan(10); // hdg east → longitude increases
  });

  it("leads a ship farther than an aircraft would at the same speed (longer lead time)", () => {
    expect(SHIP_LEAD_SECONDS).toBeGreaterThan(AIRCRAFT_LEAD_SECONDS);
  });
});
