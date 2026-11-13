import {
  aboveHorizon,
  apparentElevationDeg,
  distanceAndBearing,
  EFFECTIVE_EARTH_RADIUS_M,
  FINGER_TOLERANCE_DEG,
  horizonDistanceM,
  identifyAt,
  identifyLandmark,
  LANDMARK_REFETCH_KM,
  MAX_RANGE_KM,
  prepareLandmarks,
  RETICLE_TOLERANCE_DEG,
  shouldRefetchLandmarks,
  significance,
  type Landmark,
  type LandmarkKind,
} from "@/ar/identify";
import { EARTH_RADIUS_M } from "@/ar/geo";
import demoLandmarks from "@/mock/demo-landmarks.json";

const OBS = { lat: 59.9, lon: 10.75, alt: 100 };

/** The point `km` away from OBS on `bearing` (spherical destination formula). */
function at(bearingDeg: number, km: number, from = OBS): { lat: number; lon: number } {
  const d = (km * 1000) / EARTH_RADIUS_M;
  const b = (bearingDeg * Math.PI) / 180;
  const p1 = (from.lat * Math.PI) / 180;
  const l1 = (from.lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 =
    l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: (p2 * 180) / Math.PI, lon: (l2 * 180) / Math.PI };
}

let seq = 0;
function lm(kind: LandmarkKind, bearing: number, km: number, over: Partial<Landmark> = {}): Landmark {
  seq += 1;
  return { id: `t${seq}`, kind, name: `${kind}-${seq}`, ...at(bearing, km), ...over };
}

describe("geometry", () => {
  it("measures great-circle distance and initial bearing", () => {
    const north = distanceAndBearing({ lat: 59.9, lon: 10.75 }, { lat: 60.9, lon: 10.75 });
    expect(north.distanceM / 1000).toBeCloseTo(111.2, 0);
    expect(north.bearingDeg).toBeCloseTo(0, 6);

    const east = distanceAndBearing(OBS, at(90, 50));
    expect(east.distanceM / 1000).toBeCloseTo(50, 3);
    expect(east.bearingDeg).toBeCloseTo(90, 3);

    expect(distanceAndBearing(OBS, at(270, 10)).bearingDeg).toBeCloseTo(270, 3);
  });

  it("drops a distant point by the curvature of the refraction-bent Earth", () => {
    // Same height 100 km away: drop = d² / 2R′ ≈ 683 m.
    const drop = (100_000 ** 2) / (2 * EFFECTIVE_EARTH_RADIUS_M);
    expect(drop).toBeCloseTo(683, -1);
    expect(apparentElevationDeg(100, 100, 100_000)).toBeCloseTo((Math.atan(-drop / 100_000) * 180) / Math.PI, 6);
    // Close by, curvature is negligible: 100 m higher at 1 km is ~5.7°.
    expect(apparentElevationDeg(0, 100, 1000)).toBeCloseTo(5.71, 1);
  });

  it("puts the sea-level horizon ~38 km out from 100 m and hides what the bulge covers", () => {
    expect(horizonDistanceM(100) / 1000).toBeCloseTo(38.3, 0);
    expect(horizonDistanceM(-5)).toBe(0);
    // A 200 m hill 100 km away is hidden from the beach (5 km + 54 km of horizon), visible from 1 000 m up.
    expect(aboveHorizon(2, 200, 100_000)).toBe(false);
    expect(aboveHorizon(1000, 200, 100_000)).toBe(true);
  });
});

describe("significance", () => {
  it("ranks peaks by isolation and height, places by class and population", () => {
    const big = significance({ id: "a", kind: "peak", name: "", lat: 0, lon: 0, elevationM: 1883, isolationKm: 97 });
    const knoll = significance({ id: "b", kind: "peak", name: "", lat: 0, lon: 0, elevationM: 300, isolationKm: 3 });
    expect(big).toBeGreaterThan(knoll);
    expect(big).toBeLessThanOrEqual(1);

    const city = significance({ id: "c", kind: "city", name: "", lat: 0, lon: 0, population: 1_000_000 });
    const village = significance({ id: "d", kind: "village", name: "", lat: 0, lon: 0 });
    expect(city).toBe(1);
    expect(village).toBeCloseTo(0.4, 6);
  });
});

describe("prepareLandmarks", () => {
  it("drops what is out of its kind's range, too close, beyond the horizon, or a peak without a height", () => {
    const keep = lm("city", 90, 30);
    const farVillage = lm("village", 90, MAX_RANGE_KM.village + 5);
    const underfoot = lm("town", 0, 0.5);
    // 150 m at 140 km from 100 m up: horizons 38 + 47 km — hidden.
    const hidden = lm("peak", 180, 140, { elevationM: 150, isolationKm: 10 });
    const noHeight = lm("peak", 45, 20, { elevationM: null });

    const ids = prepareLandmarks(OBS, [keep, farVillage, underfoot, hidden, noHeight]).map((p) => p.landmark.id);

    expect(ids).toEqual([keep.id]);
  });

  it("gives a peak an elevation band from part-way up to its summit", () => {
    const [p] = prepareLandmarks(OBS, [lm("peak", 270, 10, { elevationM: 600, isolationKm: 5 })]);
    expect(p.bandHighDeg).toBeCloseTo(apparentElevationDeg(100, 600, 10_000), 6);
    expect(p.bandLowDeg).toBeCloseTo(apparentElevationDeg(100, 360, 10_000), 6);
    expect(p.bandLowDeg).toBeLessThan(p.bandHighDeg);
  });

  it("gives a place without a surveyed height the whole plausible-terrain band", () => {
    const [p] = prepareLandmarks(OBS, [lm("town", 0, 20)]);
    expect(p.bandLowDeg).toBeCloseTo(apparentElevationDeg(100, 0, 20_000), 6);
    expect(p.bandHighDeg).toBeCloseTo(apparentElevationDeg(100, 600, 20_000), 6);
  });
});

describe("identify", () => {
  const gausta = (demoLandmarks as Landmark[]).find((l) => l.name === "Gaustatoppen")!;

  it("names Gaustatoppen when pointing just above the western horizon from the demo home", () => {
    const { bearingDeg } = distanceAndBearing(OBS, gausta);
    const res = identifyLandmark(OBS, { azimuth: bearingDeg, elevation: 0.3 }, demoLandmarks as Landmark[]);

    expect(res?.best.landmark.name).toBe("Gaustatoppen");
    expect(res!.best.distanceKm).toBeGreaterThan(110);
    expect(res!.best.distanceKm).toBeLessThan(125);
    expect(res!.best.errorDeg).toBeLessThan(0.5);
  });

  it("returns nothing for empty sky, even at a landmark's bearing", () => {
    const { bearingDeg } = distanceAndBearing(OBS, gausta);
    expect(identifyLandmark(OBS, { azimuth: bearingDeg, elevation: 20 }, demoLandmarks as Landmark[])).toBeNull();
  });

  it("returns nothing where no landmark lies in the cone, or with nothing loaded", () => {
    const only = [lm("peak", 90, 20, { elevationM: 500, isolationKm: 10 })];
    expect(identifyLandmark(OBS, { azimuth: 200, elevation: 0 }, only)).toBeNull();
    expect(identifyLandmark(OBS, { azimuth: 90, elevation: 0 }, [])).toBeNull();
  });

  it("matches within the tolerance cone and not beyond it", () => {
    const peak = lm("peak", 90, 20, { elevationM: 500, isolationKm: 10 });
    const top = apparentElevationDeg(100, 500, 20_000);
    expect(identifyLandmark(OBS, { azimuth: 93, elevation: top }, [peak])?.best.landmark.id).toBe(peak.id);
    expect(identifyLandmark(OBS, { azimuth: 95, elevation: top }, [peak])).toBeNull();
    // The reticle's cone is narrower.
    expect(
      identifyLandmark(OBS, { azimuth: 93, elevation: top }, [peak], { toleranceDeg: RETICLE_TOLERANCE_DEG }),
    ).toBeNull();
    expect(FINGER_TOLERANCE_DEG).toBeGreaterThan(RETICLE_TOLERANCE_DEG);
  });

  it("counts a point on the flank of a peak, and puts the marker where the finger is inside the band", () => {
    const peak = lm("peak", 90, 10, { elevationM: 800, isolationKm: 8 });
    const top = apparentElevationDeg(100, 800, 10_000);
    const res = identifyLandmark(OBS, { azimuth: 90, elevation: top - 1 }, [peak]);
    expect(res?.best.errorDeg).toBe(0);
    expect(res?.best.elevationDeg).toBeCloseTo(top - 1, 6);
    expect(res?.best.azimuthDeg).toBeCloseTo(90, 3);
  });

  it("matches a town by bearing near the horizon but not when pointing well above it", () => {
    const town = lm("town", 10, 20);
    expect(identifyLandmark(OBS, { azimuth: 11, elevation: 0 }, [town])?.best.landmark.id).toBe(town.id);
    expect(identifyLandmark(OBS, { azimuth: 10, elevation: 8 }, [town])).toBeNull();
  });

  it("lets a nearer peak that appears higher hide a farther one at the same bearing", () => {
    const near = lm("peak", 300, 5, { elevationM: 600, isolationKm: 4 });
    const far = lm("peak", 300.3, 60, { elevationM: 1200, isolationKm: 60 });
    // Point at the far summit's apparent elevation (below the near one's summit).
    const farTop = apparentElevationDeg(100, 1200, 60_000);
    expect(apparentElevationDeg(100, 600, 5000)).toBeGreaterThan(farTop);
    const res = identifyLandmark(OBS, { azimuth: 300.3, elevation: farTop }, [near, far]);
    expect(res?.best.landmark.id).toBe(near.id);
    expect(res?.alternatives.map((a) => a.landmark.id)).not.toContain(far.id);
  });

  it("prefers the more significant of two peaks at the same miss, and the nearer of two equals", () => {
    const knoll = lm("peak", 45, 30, { elevationM: 700, isolationKm: 3 });
    const massif = lm("peak", 47, 30, { elevationM: 700, isolationKm: 40 });
    const top = apparentElevationDeg(100, 700, 30_000);
    expect(identifyLandmark(OBS, { azimuth: 46, elevation: top }, [knoll, massif])?.best.landmark.id).toBe(massif.id);

    const nearTown = lm("town", 120, 10);
    const farTown = lm("town", 120, 40);
    const res = identifyLandmark(OBS, { azimuth: 120, elevation: -0.2 }, [farTown, nearTown]);
    expect(res?.best.landmark.id).toBe(nearTown.id);
    expect(res?.alternatives.map((a) => a.landmark.id)).toEqual([farTown.id]);
  });

  it("caps the alternatives", () => {
    const towns = [1, 2, 3, 4].map((i) => lm("town", 200, 5 + i * 5));
    const res = identifyAt(prepareLandmarks(OBS, towns), { azimuth: 200, elevation: -0.5 }, { maxAlternatives: 1 });
    expect(res?.alternatives).toHaveLength(1);
  });
});

describe("shouldRefetchLandmarks", () => {
  it("fetches first, then only after the observer moves the refetch distance", () => {
    expect(shouldRefetchLandmarks(null, OBS)).toBe(true);
    expect(shouldRefetchLandmarks(OBS, at(0, LANDMARK_REFETCH_KM - 1))).toBe(false);
    expect(shouldRefetchLandmarks(OBS, at(0, LANDMARK_REFETCH_KM + 1))).toBe(true);
  });
});

describe("demo sample", () => {
  it("is real GeoNames rows around the demo home: named, typed, with peak heights", () => {
    const all = demoLandmarks as Landmark[];
    expect(all.length).toBeGreaterThan(20);
    expect(all.length).toBeLessThan(200);
    for (const l of all) {
      expect(l.id).toMatch(/^g\d+$/);
      expect(l.name.length).toBeGreaterThan(0);
      if (l.kind === "peak") expect(l.elevationM).toEqual(expect.any(Number));
      expect(distanceAndBearing(OBS, l).distanceM).toBeLessThanOrEqual(150_000);
    }
  });
});
