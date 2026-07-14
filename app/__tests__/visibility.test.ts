/**
 * Pure naked-eye-visibility fusion. Four concerns, mirroring satellites.test.ts / planets.test.ts style:
 *  1. isObserverDark — astronomy-engine Sun altitude vs a twilight threshold. Deterministic (a function
 *     of date+observer with no external state), so these are SOLID pins, not TLE-age-caveated ones.
 *  2. isSatSunlit — the cylindrical Earth-shadow geometry, exercised with positions BUILT from the real
 *     Sun unit vector at a fixed instant (no hardcoded Sun coordinates), so the frame can't quietly drift.
 *  3. passVisibility — over the real ISS fixture TLE. The winter-evening scan carries the same "TLE age"
 *     caveat the satellites.test.ts pins do: the fixture epoch is 2026-07-11, so a January propagation is
 *     far past SGP4's accurate window — we assert COHERENCE (bounds, ordering) + a per-instant re-check of
 *     the three conditions, not a physically-true window. The summer-noon case is a solid not-dark pin.
 *  4. isVisibleNow — sunlit ∧ dark composition, checked against its own parts.
 */

import {
  CIVIL_TWILIGHT_DEG,
  EARTH_RADIUS_KM,
  isObserverDark,
  isSatSunlit,
  isSatSunlitFromSunHat,
  isVisibleNow,
  passVisibility,
  sunUnitVector,
  type EquatorialVec,
} from "@/ar/visibility";
import { buildSatrec, nextPass, type SatellitePass } from "@/ar/satellites";
import { deg2rad, rad2deg } from "@/ar/geo";
import { ecfToLookAngles, eciToEcf, gstime, propagate } from "satellite.js";
import type { SatelliteDto } from "@/api/types";

/** Verbatim ISS OMM from backend/tests/Api.Tests/fixtures/tle.json (stations[0]) — matches satellites.test.ts. */
const ISS_OMM = {
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
} as const;

const OSLO = { lat: 59.9, lon: 10.7, alt: 100 };

function issSatrec() {
  return buildSatrec(ISS_OMM as unknown as SatelliteDto["omm"])!;
}

/** ECI position (km) of the ISS fixture at `date`, or null if the SGP4 step has no position. */
function issEci(date: Date): EquatorialVec | null {
  const pv = propagate(issSatrec(), date);
  return pv && pv.position ? pv.position : null;
}

/** Elevation (deg) of the ISS fixture over Oslo at `date`, via the same look-angle path passVisibility uses. */
function issElevationDeg(date: Date): number {
  const observerGd = {
    longitude: deg2rad(OSLO.lon),
    latitude: deg2rad(OSLO.lat),
    height: OSLO.alt / 1000,
  };
  const eci = issEci(date)!;
  return rad2deg(ecfToLookAngles(observerGd, eciToEcf(eci, gstime(date))).elevation);
}

describe("isObserverDark — Sun below a twilight threshold at the observer", () => {
  it("exposes the civil-twilight default of −6°", () => {
    expect(CIVIL_TWILIGHT_DEG).toBe(-6);
  });

  it("is false at Oslo summer noon (the Sun is high, ~51.5° up)", () => {
    // 2026-07-14T11:00Z ≈ 13:00 local: the same instant planets.test.ts pins the Sun at ~51.5° altitude,
    // far above −6°, so the sky is nowhere near dark.
    expect(isObserverDark(OSLO, new Date("2026-07-14T11:00:00Z"))).toBe(false);
  });

  it("is true at Oslo winter midnight (the Sun is deep below the horizon)", () => {
    // 2026-01-15T23:00Z ≈ midnight local in deep winter — the Sun sits tens of degrees under the horizon.
    expect(isObserverDark(OSLO, new Date("2026-01-15T23:00:00Z"))).toBe(true);
  });

  it("honours an explicit thresholdDeg (the Sun ~51.5° up is 'below' a 60° threshold)", () => {
    // Same summer-noon Sun (~51.5°): with the default −6° it is NOT dark, but raise the threshold above the
    // Sun's altitude and the predicate flips — proving thresholdDeg is really wired into the comparison.
    const summerNoon = new Date("2026-07-14T11:00:00Z");
    expect(isObserverDark(OSLO, summerNoon, -6)).toBe(false);
    expect(isObserverDark(OSLO, summerNoon, 60)).toBe(true);
  });
});

describe("sunUnitVector + isSatSunlit — cylindrical Earth-shadow geometry", () => {
  // Fix an instant and take the Sun direction FROM THE REAL FUNCTION, then build every test position
  // relative to it — so we assert the geometry, never a hardcoded ephemeris value.
  const DATE = new Date("2026-07-14T12:00:00Z");
  const sunHat = sunUnitVector(DATE);
  const LEO_R = 6800; // km, a representative low-Earth-orbit radius

  /** A unit vector perpendicular to `sunHat` (Gram–Schmidt off an axis that isn't near-parallel to it). */
  function perpUnit(): EquatorialVec {
    const seed = Math.abs(sunHat.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const dot = seed.x * sunHat.x + seed.y * sunHat.y + seed.z * sunHat.z;
    const v = { x: seed.x - dot * sunHat.x, y: seed.y - dot * sunHat.y, z: seed.z - dot * sunHat.z };
    const len = Math.hypot(v.x, v.y, v.z);
    return { x: v.x / len, y: v.y / len, z: v.z / len };
  }

  it("returns a unit vector", () => {
    expect(Math.hypot(sunHat.x, sunHat.y, sunHat.z)).toBeCloseTo(1, 9);
  });

  it("exposes Earth's equatorial radius (6378.137 km) as the shadow-cylinder radius", () => {
    expect(EARTH_RADIUS_KM).toBeCloseTo(6378.137, 3);
  });

  it("is sunlit when the satellite is on the sunward side (projection s > 0)", () => {
    // Straight along +sunHat at LEO radius → s = +6800 > 0 → sunlit regardless of perpendicular distance.
    const r: EquatorialVec = { x: sunHat.x * LEO_R, y: sunHat.y * LEO_R, z: sunHat.z * LEO_R };
    expect(isSatSunlit(r, DATE)).toBe(true);
    expect(isSatSunlitFromSunHat(r, sunHat)).toBe(true);
  });

  it("is in shadow when exactly anti-solar at LEO radius (inside the cylinder)", () => {
    // Along −sunHat at LEO radius → s = −6800 < 0 and the perpendicular distance from the anti-solar axis
    // is 0 < R_EARTH → the satellite is buried in Earth's shadow → not sunlit.
    const r: EquatorialVec = { x: -sunHat.x * LEO_R, y: -sunHat.y * LEO_R, z: -sunHat.z * LEO_R };
    expect(isSatSunlit(r, DATE)).toBe(false);
    expect(isSatSunlitFromSunHat(r, sunHat)).toBe(false);
  });

  it("is sunlit when anti-solar but displaced 7000 km off the axis (pokes out of the cylinder)", () => {
    // 1000 km behind Earth (s < 0) but 7000 km sideways → perpendicular distance 7000 > 6378 → sunlit.
    const p = perpUnit();
    const r: EquatorialVec = {
      x: -1000 * sunHat.x + 7000 * p.x,
      y: -1000 * sunHat.y + 7000 * p.y,
      z: -1000 * sunHat.z + 7000 * p.z,
    };
    expect(isSatSunlit(r, DATE)).toBe(true);
  });

  it("switches at the cylinder radius (just inside → shadow, just outside → sunlit)", () => {
    // Anti-solar, varying only the perpendicular offset around Earth's radius. Exact-equality on the '>'
    // boundary is float-fragile (|perp| rounds to R ± ε), so bracket it with a comfortable ±50 km margin.
    const p = perpUnit();
    const behind = { x: -1000 * sunHat.x, y: -1000 * sunHat.y, z: -1000 * sunHat.z };
    const offset = (d: number): EquatorialVec => ({
      x: behind.x + d * p.x,
      y: behind.y + d * p.y,
      z: behind.z + d * p.z,
    });
    expect(isSatSunlitFromSunHat(offset(EARTH_RADIUS_KM - 50), sunHat)).toBe(false); // inside the cylinder
    expect(isSatSunlitFromSunHat(offset(EARTH_RADIUS_KM + 50), sunHat)).toBe(true); // clear of the cylinder
  });
});

describe("passVisibility — naked-eye window of a real ISS pass over Oslo", () => {
  const MASK = 10;

  it("returns a coherent visible window for a dark winter-evening pass, re-verified per condition", () => {
    // TLE-age caveat: the ISS fixture epoch is 2026-07-11, so propagating it to this January evening is
    // well past SGP4's accurate window. We therefore assert COHERENCE (a boolean result whose window lies
    // within [aos, los] with start ≤ end) plus a per-instant re-check of the three visibility conditions —
    // NOT a physically-true window. At this satellite.js version the found pass is a real dark-sky pass
    // that is sunlit at rise before the ISS enters Earth's shadow, so `visible` is true here.
    const satrec = issSatrec();
    const from = new Date("2026-01-15T16:00:00Z"); // ~17:00 local: already astronomically dark in Oslo winter
    const pass = nextPass(satrec, OSLO, from, MASK, { horizonHours: 24 });
    expect(pass).not.toBeNull();

    const vis = passVisibility({ satrec, observer: OSLO, pass: pass!, elevationMaskDeg: MASK });
    expect(typeof vis.visible).toBe("boolean");

    if (vis.visible) {
      // Window is a real sub-interval of the pass, correctly ordered.
      expect(vis.visibleStart).toBeInstanceOf(Date);
      expect(vis.visibleEnd).toBeInstanceOf(Date);
      expect(vis.visibleStart!.getTime()).toBeGreaterThanOrEqual(pass!.aosTime.getTime());
      expect(vis.visibleEnd!.getTime()).toBeLessThanOrEqual(pass!.losTime.getTime());
      expect(vis.visibleStart!.getTime()).toBeLessThanOrEqual(vis.visibleEnd!.getTime());

      // Sanity cross-check: at the claimed-visible instant, re-assert all THREE conditions independently.
      const t = vis.visibleStart!;
      expect(issElevationDeg(t)).toBeGreaterThanOrEqual(MASK);
      expect(isSatSunlit(issEci(t)!, t)).toBe(true);
      expect(isObserverDark(OSLO, t)).toBe(true);
    } else {
      // The clamp: never-visible ⇒ both bounds null.
      expect(vis.visibleStart).toBeNull();
      expect(vis.visibleEnd).toBeNull();
    }
  });

  it("is deterministic across repeated evaluation of the same pass", () => {
    const satrec = issSatrec();
    const pass = nextPass(satrec, OSLO, new Date("2026-01-15T16:00:00Z"), MASK, { horizonHours: 24 })!;
    const a = passVisibility({ satrec, observer: OSLO, pass, elevationMaskDeg: MASK });
    const b = passVisibility({ satrec, observer: OSLO, pass, elevationMaskDeg: MASK });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("reports NOT visible for a daylight (summer-noon) pass — the sky is never dark", () => {
    // A synthetic pass window straddling Oslo summer noon. WHY not-visible: at every sample the Sun is
    // ~51.5° up, so isObserverDark is false no matter where the satellite is — no sample can qualify,
    // regardless of whether the ISS is sunlit. Deterministic (no TLE-age dependence on the window).
    const noonPass: SatellitePass = {
      aosTime: new Date("2026-07-14T10:55:00Z"),
      losTime: new Date("2026-07-14T11:05:00Z"),
      maxElevationDeg: 45,
      maxElevationTime: new Date("2026-07-14T11:00:00Z"),
      aosAzimuthDeg: 200,
      losAzimuthDeg: 120,
      inProgress: false,
    };
    const vis = passVisibility({ satrec: issSatrec(), observer: OSLO, pass: noonPass, elevationMaskDeg: 5 });
    expect(vis.visible).toBe(false);
    expect(vis.visibleStart).toBeNull();
    expect(vis.visibleEnd).toBeNull();
  });
});

describe("isVisibleNow — sunlit ∧ dark, unmasked", () => {
  it("is false whenever the observer's sky is not dark (summer noon), regardless of the satellite", () => {
    // Sun ~51.5° up ⇒ not dark ⇒ not visible, whatever the ISS geometry is.
    const date = new Date("2026-07-14T11:00:00Z");
    expect(isObserverDark(OSLO, date)).toBe(false);
    expect(isVisibleNow({ satrec: issSatrec(), observer: OSLO, date })).toBe(false);
  });

  it("equals its own parts (sunlit(eci) ∧ dark) at a dark winter instant", () => {
    // Compose-check against the independent predicates on the exact same ECI/observer/instant — guards the
    // wiring without pinning a stale-TLE boolean.
    const satrec = issSatrec();
    const date = new Date("2026-01-15T18:00:00Z");
    const expected = isSatSunlit(issEci(date)!, date) && isObserverDark(OSLO, date);
    expect(isVisibleNow({ satrec, observer: OSLO, date })).toBe(expected);
  });
});
