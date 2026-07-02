import {
  angleDiff,
  enuToLookAngles,
  geodeticToEnu,
  lookAngles,
  normalizeAzimuth,
  EARTH_RADIUS_M,
  METERS_PER_DEG,
  type GeoPoint,
} from "@/ar/geo";

const HOME: GeoPoint = { lat: 59.9, lon: 10.7, alt: 100 }; // Oslo-ish observer, 100 m

describe("geodeticToEnu", () => {
  it("maps due-north target to +N, ~0 E", () => {
    const target: GeoPoint = { lat: 59.9 + 0.01, lon: 10.7, alt: 100 };
    const enu = geodeticToEnu(HOME, target);
    expect(enu.n).toBeCloseTo(0.01 * METERS_PER_DEG, 3);
    expect(enu.e).toBeCloseTo(0, 6);
  });

  it("scales east by cos(latitude)", () => {
    const target: GeoPoint = { lat: 59.9, lon: 10.7 + 0.01, alt: 100 };
    const enu = geodeticToEnu(HOME, target);
    const expectedE = 0.01 * METERS_PER_DEG * Math.cos((59.9 * Math.PI) / 180);
    expect(enu.e).toBeCloseTo(expectedE, 3);
    expect(enu.n).toBeCloseTo(0, 6);
  });

  it("subtracts the earth-curvature drop from up", () => {
    // A point 10 km north at the same MSL altitude sits below the local horizontal
    // by ground²/(2R).
    const north10km = 10_000 / METERS_PER_DEG;
    const target: GeoPoint = { lat: 59.9 + north10km, lon: 10.7, alt: 100 };
    const enu = geodeticToEnu(HOME, target);
    const expectedDrop = (10_000 * 10_000) / (2 * EARTH_RADIUS_M);
    expect(enu.u).toBeCloseTo(-expectedDrop, 1);
    expect(expectedDrop).toBeGreaterThan(7); // ~7.8 m over 10 km
  });
});

describe("enuToLookAngles", () => {
  it("due north at 45° elevation", () => {
    // 1000 m north, 1000 m up → az 0, el 45.
    const angles = enuToLookAngles({ e: 0, n: 1000, u: 1000 });
    expect(angles.azimuth).toBeCloseTo(0, 6);
    expect(angles.elevation).toBeCloseTo(45, 6);
    expect(angles.slantRange).toBeCloseTo(Math.hypot(1000, 1000), 6);
    expect(angles.groundDistance).toBeCloseTo(1000, 6);
  });

  it("due east is azimuth 90", () => {
    const angles = enuToLookAngles({ e: 1000, n: 0, u: 0 });
    expect(angles.azimuth).toBeCloseTo(90, 6);
    expect(angles.elevation).toBeCloseTo(0, 6);
  });

  it("due south is azimuth 180", () => {
    const angles = enuToLookAngles({ e: 0, n: -1000, u: 0 });
    expect(angles.azimuth).toBeCloseTo(180, 6);
  });

  it("due west is azimuth 270", () => {
    const angles = enuToLookAngles({ e: -1000, n: 0, u: 0 });
    expect(angles.azimuth).toBeCloseTo(270, 6);
  });

  it("straight up is elevation 90", () => {
    const angles = enuToLookAngles({ e: 0, n: 0, u: 5000 });
    expect(angles.elevation).toBeCloseTo(90, 6);
  });
});

describe("normalizeAzimuth", () => {
  it.each([
    [0, 0],
    [360, 0],
    [-90, 270],
    [450, 90],
    [-370, 350],
  ])("normalizes %p to %p", (input, expected) => {
    expect(normalizeAzimuth(input)).toBeCloseTo(expected, 9);
  });
});

describe("angleDiff wrap-around", () => {
  it("handles the ±180 wrap", () => {
    expect(angleDiff(170, -170)).toBeCloseTo(-20, 9); // 170 is 20° CCW of 190≡-170
    expect(angleDiff(-170, 170)).toBeCloseTo(20, 9);
    expect(angleDiff(10, 350)).toBeCloseTo(20, 9);
    expect(angleDiff(350, 10)).toBeCloseTo(-20, 9);
  });

  it("is zero for equal angles across the wrap", () => {
    expect(angleDiff(180, -180)).toBeCloseTo(0, 9);
    expect(angleDiff(0, 360)).toBeCloseTo(0, 9);
  });
});

describe("lookAngles end-to-end", () => {
  it("an aircraft due north and high is north + positive elevation", () => {
    // ~5 km north, 3000 m altitude vs 100 m observer.
    const northDeg = 5000 / METERS_PER_DEG;
    const target: GeoPoint = { lat: HOME.lat + northDeg, lon: HOME.lon, alt: 3000 };
    const angles = lookAngles(HOME, target);
    expect(angles.azimuth).toBeCloseTo(0, 1);
    expect(angles.elevation).toBeGreaterThan(20);
    expect(angles.elevation).toBeLessThan(40);
  });
});
