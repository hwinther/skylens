/**
 * Pure satellite propagation + selection. Four concerns:
 *  1. ISS reference — a real OMM (copied from backend/tests/Api.Tests/fixtures/tle.json) propagated
 *     at a fixed instant, asserted against SELF-DERIVED reference values. These are NOT external
 *     truth: they were produced by running this very module once and pinning the outputs, so they
 *     guard against a regression in the satellite.js wiring (the ECI→ECF→look-angle chain, the
 *     dopplerFactor sign) rather than validating SGP4 itself. Tolerances (±0.5° / ±5 km) leave room
 *     for a satellite.js patch release without going brittle.
 *  2. selectVisible — elevation-mask filtering, group-priority ordering, and cap eviction.
 *  3. dopplerCorrectedHz — the approaching-is-higher sign convention.
 *  4. buildSatrecs — a corrupt OMM is dropped, never thrown.
 */

import {
  buildSatrec,
  buildSatrecs,
  clampEpochFraction,
  dopplerCorrectedHz,
  extrapolateView,
  formatCountdown,
  formatFrequencyHz,
  formatPassDuration,
  GROUP_PRIORITY,
  groundTrack,
  MAX_EXTRAPOLATION_S,
  MAX_TRACK_SPAN_MIN,
  MIN_TRACK_SPAN_MIN,
  nextPass,
  normalizeLon,
  orbitalPeriodMinutes,
  propagateAll,
  RATE_SAMPLE_S,
  satGroupsFromSettings,
  SATELLITE_RENDER_CAP,
  selectVisible,
  splitAtAntimeridian,
  subSatellitePoint,
  type GroundTrackPoint,
  type SatelliteView,
  type SatGroup,
} from "@/ar/satellites";
import type { SatRec } from "satellite.js";
import { angleDiff } from "@/ar/geo";
import type { SatelliteDto } from "@/api/types";

/** Verbatim ISS OMM from backend/tests/Api.Tests/fixtures/tle.json (stations[0]). */
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

function issDto(): SatelliteDto {
  return {
    noradId: 25544,
    name: "ISS (ZARYA)",
    group: "stations",
    freqSummary: "145.800 MHz FM",
    omm: ISS_OMM as unknown as SatelliteDto["omm"],
  };
}

/** Verbatim GPS BIIR-5 OMM from backend/tests/Api.Tests/fixtures/tle.json (gps-ops[0]) — a MEO sat. */
const GPS_OMM = {
  OBJECT_NAME: "GPS BIIR-5  (PRN 22)",
  OBJECT_ID: "2000-040A",
  EPOCH: "2026-07-11T16:25:05.022624",
  MEAN_MOTION: 2.00557794,
  ECCENTRICITY: 0.01205638,
  INCLINATION: 54.8489,
  RA_OF_ASC_NODE: 214.1892,
  ARG_OF_PERICENTER: 302.6973,
  MEAN_ANOMALY: 28.6671,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: "U",
  NORAD_CAT_ID: 26407,
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 19043,
  BSTAR: 0,
  MEAN_MOTION_DOT: 1.02e-6,
  MEAN_MOTION_DDOT: 0,
} as const;

/** Assert a Date lands within `toleranceMs` of an expected ISO instant (pass-time regression pin). */
function expectTimeNear(actual: Date, expectedIso: string, toleranceMs: number) {
  expect(Math.abs(actual.getTime() - new Date(expectedIso).getTime())).toBeLessThanOrEqual(toleranceMs);
}

/** Fabricate a bare SatelliteView for selection tests (no propagation involved). */
function view(noradId: number, group: SatGroup, elevationDeg: number): SatelliteView {
  return {
    noradId,
    name: `sat-${noradId}`,
    group,
    azimuthDeg: 180,
    elevationDeg,
    azimuthRateDegS: 0,
    elevationRateDegS: 0,
    rangeKm: 1000,
    rangeRateKmS: 0,
    subLat: 0,
    subLon: 0,
  };
}

describe("propagateAll — ISS reference pass over Oslo (self-derived pins)", () => {
  // Observer: Oslo-ish, 100 m. Fixed instant is a real visible pass ~14.3 h after the TLE epoch,
  // found by scanning: the ISS is ~20° up in the south, closing (negative range rate).
  const observer = { lat: 59.9, lon: 10.7, alt: 100 };
  const date = new Date("2026-07-11T21:52:23.712Z");

  it("places the ISS at the pinned azimuth / elevation / range", () => {
    const views = propagateAll(buildSatrecs([issDto()]), observer, date);
    expect(views).toHaveLength(1);
    const v = views[0];
    // Self-derived reference: az≈193.02°, el≈20.03°, range≈1046.97 km.
    expect(v.azimuthDeg).toBeCloseTo(193.02, 1); // ±0.05°, well inside the ±0.5° budget
    expect(v.elevationDeg).toBeGreaterThan(20.03 - 0.5);
    expect(v.elevationDeg).toBeLessThan(20.03 + 0.5);
    expect(v.rangeKm).toBeGreaterThan(1046.97 - 5);
    expect(v.rangeKm).toBeLessThan(1046.97 + 5);
    // Near closest approach it is still closing → range rate negative (downlink Doppler-shifts up).
    expect(v.rangeRateKmS).toBeLessThan(0);
    // Identity + freq carried through from the DTO.
    expect(v.noradId).toBe(25544);
    expect(v.group).toBe("stations");
    expect(v.freqSummary).toBe("145.800 MHz FM");
  });

  it("is deterministic across repeated propagation of the same instant", () => {
    const a = propagateAll(buildSatrecs([issDto()]), observer, date)[0];
    const b = propagateAll(buildSatrecs([issDto()]), observer, date)[0];
    expect(a.azimuthDeg).toBe(b.azimuthDeg);
    expect(a.elevationDeg).toBe(b.elevationDeg);
    expect(a.rangeKm).toBe(b.rangeKm);
  });

  it("carries a sub-satellite point (subLat/subLon) self-consistent with a direct eciToGeodetic", () => {
    const v = propagateAll(buildSatrecs([issDto()]), observer, date)[0];
    // Finite and in-range: latitude bounded by |inclination| (51.63°), longitude normalised to [-180, 180).
    expect(Number.isFinite(v.subLat)).toBe(true);
    expect(Number.isFinite(v.subLon)).toBe(true);
    expect(v.subLat).toBeGreaterThanOrEqual(-90);
    expect(v.subLat).toBeLessThanOrEqual(90);
    expect(v.subLon).toBeGreaterThanOrEqual(-180);
    expect(v.subLon).toBeLessThan(180);
    // The SAME reduction (propagate → gstime → eciToGeodetic) run standalone must agree exactly — this
    // guards the sub-point wiring against a regression without pinning an external truth value.
    const direct = subSatellitePoint(buildSatrec(ISS_OMM as unknown as SatelliteDto["omm"])!, date)!;
    expect(v.subLat).toBeCloseTo(direct.lat, 6);
    expect(v.subLon).toBeCloseTo(direct.lon, 6);
    // Self-derived pin: the ISS is over central Europe (~51.77°N, ~7.69°E) at this instant.
    expect(v.subLat).toBeCloseTo(51.7665, 0); // ±0.5°
    expect(v.subLon).toBeCloseTo(7.6907, 0);
  });

  it("carries az/el angular rates that self-consistently finite-difference two propagations", () => {
    // The rate propagateAll carries at `date` must equal a finite difference between the primary sample
    // at `date` and a second primary sample RATE_SAMPLE_S ahead (its internal second sample IS that
    // next-instant primary sample), 0/360-wrap-safe via angleDiff. This guards the rate wiring against
    // a regression without pinning an external truth value.
    const v0 = propagateAll(buildSatrecs([issDto()]), observer, date)[0];
    const vAhead = propagateAll(
      buildSatrecs([issDto()]),
      observer,
      new Date(date.getTime() + RATE_SAMPLE_S * 1000),
    )[0];
    const expectedElRate = (vAhead.elevationDeg - v0.elevationDeg) / RATE_SAMPLE_S;
    const expectedAzRate = angleDiff(vAhead.azimuthDeg, v0.azimuthDeg) / RATE_SAMPLE_S;
    expect(v0.elevationRateDegS).toBeCloseTo(expectedElRate, 9);
    expect(v0.azimuthRateDegS).toBeCloseTo(expectedAzRate, 9);
  });

  it("carries plausible ISS angular-rate magnitudes at the pinned overhead epoch", () => {
    const v = propagateAll(buildSatrecs([issDto()]), observer, date)[0];
    // Near transit the ISS sweeps in azimuth fast; both rates stay well under the 2°/s ceiling that a
    // fling would blow through (and never a ±360°/s wrap spike). Loose bounds absorb a satellite.js patch.
    expect(Math.abs(v.azimuthRateDegS)).toBeGreaterThan(0.01);
    expect(Math.abs(v.azimuthRateDegS)).toBeLessThan(2);
    expect(Math.abs(v.elevationRateDegS)).toBeGreaterThan(0.01);
    expect(Math.abs(v.elevationRateDegS)).toBeLessThan(2);
  });
});

describe("angular-rate azimuth wrap — the 0/360 seam never spikes", () => {
  it("finite-differences a north crossing to a small signed rate, not ±360°/s", () => {
    // A satellite crossing due north between two 1 s samples goes 359.5° → 0.5°. A naive (az2 − az1)/dt
    // would read −359°/s; angleDiff (which propagateAll uses for the azimuth rate) reads the true +1°/s.
    expect(angleDiff(0.5, 359.5) / RATE_SAMPLE_S).toBeCloseTo(1, 9);
    // And the mirror crossing 0.5° → 359.5° (westbound through north) reads −1°/s.
    expect(angleDiff(359.5, 0.5) / RATE_SAMPLE_S).toBeCloseTo(-1, 9);
    // Never a full-circle spike in magnitude.
    expect(Math.abs(angleDiff(0.5, 359.5))).toBeLessThan(2);
  });
});

describe("extrapolateView — linear az/el lead, normalised, age-clamped", () => {
  /** A view carrying fixed rates; identity/range fields are irrelevant to extrapolation. */
  function rated(azimuthDeg: number, elevationDeg: number, azRate: number, elRate: number): SatelliteView {
    return {
      noradId: 1,
      name: "sat-1",
      group: "stations",
      azimuthDeg,
      elevationDeg,
      azimuthRateDegS: azRate,
      elevationRateDegS: elRate,
      rangeKm: 1000,
      rangeRateKmS: 0,
      subLat: 0,
      subLon: 0,
    };
  }

  it("advances az/el linearly by rate × age at 1 s", () => {
    const out = extrapolateView(rated(100, 20, 0.5, -0.3), 1);
    expect(out.azimuthDeg).toBeCloseTo(100.5, 9);
    expect(out.elevationDeg).toBeCloseTo(19.7, 9);
  });

  it("normalises azimuth across the 0/360 seam", () => {
    // 359.9° + 0.2°/s × 1 s = 360.1° → wraps to 0.1°.
    const out = extrapolateView(rated(359.9, 30, 0.2, 0), 1);
    expect(out.azimuthDeg).toBeCloseTo(0.1, 9);
  });

  it("clamps age at MAX_EXTRAPOLATION_S (a stalled/backgrounded tick cannot fling)", () => {
    const v = rated(100, 20, 0.5, -0.3);
    const atMax = extrapolateView(v, MAX_EXTRAPOLATION_S);
    const wayPast = extrapolateView(v, 60);
    expect(wayPast.azimuthDeg).toBe(atMax.azimuthDeg);
    expect(wayPast.elevationDeg).toBe(atMax.elevationDeg);
    // Concretely: 2 s of lead, not 60 s.
    expect(atMax.azimuthDeg).toBeCloseTo(101, 9);
    expect(atMax.elevationDeg).toBeCloseTo(19.4, 9);
  });

  it("clamps a negative age to 0 (no backward extrapolation)", () => {
    const out = extrapolateView(rated(100, 20, 0.5, -0.3), -5);
    expect(out.azimuthDeg).toBeCloseTo(100, 9);
    expect(out.elevationDeg).toBeCloseTo(20, 9);
  });

  it("leaves a zero-rate view where it is (steps, never flings)", () => {
    const out = extrapolateView(rated(210, 45, 0, 0), MAX_EXTRAPOLATION_S);
    expect(out.azimuthDeg).toBe(210);
    expect(out.elevationDeg).toBe(45);
  });
});

describe("nextPass — ISS pass prediction (self-derived pins)", () => {
  // Same Oslo observer as above. These AOS/LOS/maxEl values are SELF-DERIVED regression pins: produced
  // by running nextPass once and freezing the outputs (like the propagateAll pins), not external truth.
  // Tolerances (±3 s on the edges, ±0.5° on the peak) absorb a satellite.js patch without going brittle.
  const observer = { lat: 59.9, lon: 10.7, alt: 100 };

  it("predicts AOS / LOS / max elevation / rise+set bearings for the next ISS pass", () => {
    // fromDate ~9 min before the ISS clears the mask — a full rise→set arc is predicted.
    const pass = nextPass(buildSatrec(ISS_OMM as unknown as SatelliteDto["omm"])!, observer, new Date("2026-07-11T21:40:00.000Z"), 5);
    expect(pass).not.toBeNull();
    const p = pass!;
    expect(p.inProgress).toBe(false);
    expectTimeNear(p.aosTime, "2026-07-11T21:49:09.140Z", 3000);
    expectTimeNear(p.losTime, "2026-07-11T21:56:34.687Z", 3000);
    expectTimeNear(p.maxElevationTime, "2026-07-11T21:52:52.027Z", 5000);
    expect(p.maxElevationDeg).toBeGreaterThan(20.62 - 0.5);
    expect(p.maxElevationDeg).toBeLessThan(20.62 + 0.5);
    // Rise in the SW (~240°), set in the SE (~121°) — the ascending southbound arc.
    expect(p.aosAzimuthDeg).toBeCloseTo(240.35, 0); // ±0.5°
    expect(p.losAzimuthDeg).toBeCloseTo(121.32, 0);
    // AOS/LOS both sit essentially on the mask; the elevation only exceeds it in between.
    expect(p.losTime.getTime()).toBeGreaterThan(p.aosTime.getTime());
  });

  it("is deterministic across repeated prediction of the same window", () => {
    const from = new Date("2026-07-11T21:40:00.000Z");
    const a = nextPass(buildSatrec(ISS_OMM as unknown as SatelliteDto["omm"])!, observer, from, 5)!;
    const b = nextPass(buildSatrec(ISS_OMM as unknown as SatelliteDto["omm"])!, observer, from, 5)!;
    expect(a.aosTime.getTime()).toBe(b.aosTime.getTime());
    expect(a.losTime.getTime()).toBe(b.losTime.getTime());
    expect(a.maxElevationDeg).toBe(b.maxElevationDeg);
  });

  it("clamps AOS to now and flags inProgress when the satellite is already up", () => {
    // fromDate mid-pass (the propagateAll fixture instant, ISS ~20° up) → AOS clamps to fromDate.
    const from = new Date("2026-07-11T21:52:23.712Z");
    const p = nextPass(buildSatrec(ISS_OMM as unknown as SatelliteDto["omm"])!, observer, from, 5)!;
    expect(p.inProgress).toBe(true);
    expect(p.aosTime.getTime()).toBe(from.getTime()); // clamped exactly to now
    expectTimeNear(p.losTime, "2026-07-11T21:56:34.727Z", 3000);
    expect(p.maxElevationDeg).toBeGreaterThan(20.62 - 0.5);
    expect(p.maxElevationDeg).toBeLessThan(20.62 + 0.5);
  });

  it("returns null when no rise occurs within the horizon", () => {
    // Below the mask at 22:20Z with only a 36 s horizon — the next ISS pass is far outside it.
    const p = nextPass(
      buildSatrec(ISS_OMM as unknown as SatelliteDto["omm"])!,
      observer,
      new Date("2026-07-11T22:20:00.000Z"),
      5,
      { horizonHours: 0.01 },
    );
    expect(p).toBeNull();
  });

  it("clamps LOS to the horizon for an always-up MEO pass instead of spinning", () => {
    // A GPS MEO sat is above the mask for hours. With a 30 min horizon it never sets in-window, so LOS
    // must clamp to the horizon end and the pass still return (the no-hang guard) — not scan for hours.
    const from = new Date("2026-07-11T18:00:00.000Z");
    const p = nextPass(buildSatrec(GPS_OMM as unknown as SatelliteDto["omm"])!, observer, from, 5, {
      horizonHours: 0.5,
    });
    expect(p).not.toBeNull();
    expect(p!.inProgress).toBe(true);
    expect(p!.aosTime.getTime()).toBe(from.getTime());
    // LOS clamped exactly to fromDate + 30 min.
    expect(p!.losTime.getTime()).toBe(from.getTime() + 30 * 60_000);
    expect(Number.isFinite(p!.maxElevationDeg)).toBe(true);
    expect(p!.maxElevationDeg).toBeGreaterThan(40); // ~46° over this arc
  });
});

describe("normalizeLon — longitude wrapped to [-180, 180)", () => {
  it("wraps values past ±180 into range", () => {
    expect(normalizeLon(0)).toBe(0);
    expect(normalizeLon(179)).toBeCloseTo(179, 9);
    expect(normalizeLon(190)).toBeCloseTo(-170, 9);
    expect(normalizeLon(-190)).toBeCloseTo(170, 9);
    expect(normalizeLon(540)).toBeCloseTo(-180, 9); // 540 = 360 + 180 → −180
  });

  it("maps the +180 seam to −180 (the range is half-open)", () => {
    expect(normalizeLon(180)).toBe(-180);
    expect(normalizeLon(-180)).toBe(-180);
  });
});

describe("splitAtAntimeridian — segment on a >180° longitude jump", () => {
  const pts = (lons: number[]): GroundTrackPoint[] => lons.map((lon, i) => ({ lat: 0, lon, timeMs: i }));

  it("keeps a monotone run as a single segment", () => {
    const segs = splitAtAntimeridian(pts([10, 20, 30, 40]));
    expect(segs).toHaveLength(1);
    expect(segs[0].map((p) => p.lon)).toEqual([10, 20, 30, 40]);
  });

  it("splits at a 179 → −179 antimeridian crossing (jump 358° > 180°)", () => {
    const segs = splitAtAntimeridian(pts([170, 179, -179, -170]));
    expect(segs).toHaveLength(2);
    expect(segs[0].map((p) => p.lon)).toEqual([170, 179]);
    expect(segs[1].map((p) => p.lon)).toEqual([-179, -170]);
  });

  it("splits twice (→ 3 segments) for a track that wraps the antimeridian twice", () => {
    // Two >180° jumps (179→−179 and −170→179); the intervening steps stay under 180°.
    const segs = splitAtAntimeridian(pts([170, 179, -179, -170, 179]));
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.length)).toEqual([2, 2, 1]);
  });

  it("returns [] for an empty run and a single-element segment for one point", () => {
    expect(splitAtAntimeridian([])).toEqual([]);
    expect(splitAtAntimeridian(pts([42]))).toEqual([[{ lat: 0, lon: 42, timeMs: 0 }]]);
  });
});

describe("orbitalPeriodMinutes — 2π/no, clamped", () => {
  it("derives the ISS period (~93 min) from its mean motion", () => {
    const iss = buildSatrec(ISS_OMM as unknown as SatelliteDto["omm"])!;
    expect(orbitalPeriodMinutes(iss)).toBeCloseTo(92.97, 1); // ±0.05 min
  });

  it("derives the GPS MEO period (~718 min) — within the clamp window, so unclamped", () => {
    const gps = buildSatrec(GPS_OMM as unknown as SatelliteDto["omm"])!;
    const period = orbitalPeriodMinutes(gps);
    expect(period).toBeGreaterThan(700);
    expect(period).toBeLessThan(MAX_TRACK_SPAN_MIN);
  });

  it("floors a bogus (zero / non-positive) mean motion to MIN_TRACK_SPAN_MIN", () => {
    expect(orbitalPeriodMinutes({ no: 0 } as SatRec)).toBe(MIN_TRACK_SPAN_MIN);
    expect(orbitalPeriodMinutes({ no: -1 } as SatRec)).toBe(MIN_TRACK_SPAN_MIN);
  });

  it("ceils a GEO-slow mean motion to MAX_TRACK_SPAN_MIN (no day-long span)", () => {
    // A period of ~5000 min (well past the 24 h ceiling) → clamped to MAX_TRACK_SPAN_MIN.
    expect(orbitalPeriodMinutes({ no: (2 * Math.PI) / 5000 } as SatRec)).toBe(MAX_TRACK_SPAN_MIN);
  });
});

describe("groundTrack — ISS sub-satellite path (self-derived pins)", () => {
  const satrec = () => buildSatrec(ISS_OMM as unknown as SatelliteDto["omm"])!;

  it("samples ~one period at the default 30 s step and pins the first/last sub-points", () => {
    // Same instant the propagateAll sub-point pins use. This window does NOT cross the antimeridian, so
    // it stays a single segment: the track runs from the SW Pacific up through Europe to the NW Pacific.
    const date = new Date("2026-07-11T21:52:23.712Z");
    const segs = groundTrack(satrec(), date);
    expect(segs.length).toBeGreaterThanOrEqual(1);
    const total = segs.reduce((n, s) => n + s.length, 0);
    // span ≈ 92.97 min / 30 s ≈ 186 samples.
    expect(total).toBeGreaterThanOrEqual(184);
    expect(total).toBeLessThanOrEqual(188);
    // Every sample finite and in range.
    for (const seg of segs) {
      for (const p of seg) {
        expect(Number.isFinite(p.lat)).toBe(true);
        expect(Number.isFinite(p.lon)).toBe(true);
        expect(p.lat).toBeGreaterThanOrEqual(-90);
        expect(p.lat).toBeLessThanOrEqual(90);
        expect(p.lon).toBeGreaterThanOrEqual(-180);
        expect(p.lon).toBeLessThan(180);
      }
    }
    const first = segs[0][0];
    const lastSeg = segs[segs.length - 1];
    const last = lastSeg[lastSeg.length - 1];
    // Self-derived pins (±0.5°): the span is centred on `date`, so it reaches ~46 min either side.
    expect(first.lat).toBeCloseTo(-51.761, 0);
    expect(first.lon).toBeCloseTo(-160.781, 0);
    expect(last.lat).toBeCloseTo(-51.683, 0);
    expect(last.lon).toBeCloseTo(173.208, 0);
    // The centre sample sits at the live sub-point (~51.77°N, 7.69°E).
    const centre = subSatellitePoint(satrec(), date)!;
    expect(centre.lat).toBeCloseTo(51.7665, 0);
    expect(centre.lon).toBeCloseTo(7.6907, 0);
  });

  it("pre-splits into >1 segment when the orbit crosses the antimeridian within the window", () => {
    // A window centred 22 min later straddles the ±180° meridian → two segments, no wrap-around line.
    const date = new Date("2026-07-11T22:14:23.712Z");
    const segs = groundTrack(satrec(), date);
    expect(segs.length).toBeGreaterThan(1);
    // Splitting only partitions; the total sample count is unchanged (~186).
    const total = segs.reduce((n, s) => n + s.length, 0);
    expect(total).toBeGreaterThanOrEqual(184);
    expect(total).toBeLessThanOrEqual(188);
    // The seam really is a >180° jump between the two segments (never a within-segment wrap).
    for (const seg of segs) {
      for (let i = 1; i < seg.length; i++) {
        expect(Math.abs(seg[i].lon - seg[i - 1].lon)).toBeLessThanOrEqual(180);
      }
    }
  });

  it("honours an explicit span/step and is deterministic", () => {
    const date = new Date("2026-07-11T21:52:23.712Z");
    const a = groundTrack(satrec(), date, { spanMinutes: 20, stepSeconds: 60 });
    const b = groundTrack(satrec(), date, { spanMinutes: 20, stepSeconds: 60 });
    const totalA = a.reduce((n, s) => n + s.length, 0);
    // 20 min / 60 s ≈ 21 samples.
    expect(totalA).toBeGreaterThanOrEqual(20);
    expect(totalA).toBeLessThanOrEqual(22);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("formatPassDuration / formatCountdown — pure display helpers", () => {
  it("formats a pass length as zero-padded mm:ss", () => {
    expect(formatPassDuration(532_000)).toBe("08:52");
    expect(formatPassDuration(9_000)).toBe("00:09");
    expect(formatPassDuration(0)).toBe("00:00");
  });

  it("rounds to the nearest second and never goes negative", () => {
    expect(formatPassDuration(89_600)).toBe("01:30"); // 89.6 s → 90 s
    expect(formatPassDuration(-5_000)).toBe("00:00");
  });

  it("lets minutes exceed 59 for a long (clamped) arc", () => {
    expect(formatPassDuration(75 * 60_000)).toBe("75:00");
  });

  it("formats a forward delta as a coarse countdown", () => {
    expect(formatCountdown(2 * 3_600_000 + 14 * 60_000)).toBe("in 2h 14m");
    expect(formatCountdown(14 * 60_000)).toBe("in 14m");
    expect(formatCountdown(45_000)).toBe("in 45s");
  });

  it("renders 'now' for a non-positive delta", () => {
    expect(formatCountdown(0)).toBe("now");
    expect(formatCountdown(-60_000)).toBe("now");
  });
});

describe("selectVisible — mask, group priority, cap", () => {
  const allGroups = new Set<SatGroup>(["stations", "amateur", "weather", "gnss"]);

  it("drops satellites below the elevation mask", () => {
    const views = [
      view(1, "stations", 40),
      view(2, "stations", 5), // exactly at mask → kept (>=)
      view(3, "stations", 4.9), // just below → dropped
      view(4, "stations", -10),
    ];
    const out = selectVisible(views, 5, allGroups);
    expect(out.map((v) => v.noradId).sort()).toEqual([1, 2]);
  });

  it("drops satellites whose group is not enabled", () => {
    const views = [view(1, "stations", 30), view(2, "gnss", 60)];
    const out = selectVisible(views, 5, new Set<SatGroup>(["stations"]));
    expect(out.map((v) => v.noradId)).toEqual([1]);
  });

  it("sorts by group priority then descending elevation", () => {
    const views = [
      view(1, "gnss", 80),
      view(2, "stations", 10),
      view(3, "amateur", 45),
      view(4, "stations", 70),
      view(5, "weather", 30),
    ];
    const out = selectVisible(views, 5, allGroups);
    // stations (prio 0, el 70 then 10), amateur (1), weather (2), gnss (3)
    expect(out.map((v) => v.noradId)).toEqual([4, 2, 3, 5, 1]);
    expect(GROUP_PRIORITY.stations).toBeLessThan(GROUP_PRIORITY.gnss);
  });

  it("evicts low-priority groups first when over the render cap", () => {
    // 35 above-mask gnss + 2 stations = 37 candidates; cap is 30. The 2 stations (priority 0) must
    // survive and 28 gnss fill the rest — the 7 excess gnss are evicted, never the stations.
    const views: SatelliteView[] = [];
    for (let i = 0; i < 35; i++) views.push(view(1000 + i, "gnss", 20 + i * 0.1));
    views.push(view(1, "stations", 6));
    views.push(view(2, "stations", 8));

    const out = selectVisible(views, 5, new Set<SatGroup>(["stations", "gnss"]));
    expect(out).toHaveLength(SATELLITE_RENDER_CAP);
    const stationsKept = out.filter((v) => v.group === "stations").map((v) => v.noradId).sort();
    expect(stationsKept).toEqual([1, 2]);
    expect(out.filter((v) => v.group === "gnss")).toHaveLength(SATELLITE_RENDER_CAP - 2);
  });
});

describe("dopplerCorrectedHz — approaching shifts higher", () => {
  const F = 145_800_000; // 2 m amateur downlink, Hz

  it("raises the observed frequency when approaching (range rate < 0)", () => {
    expect(dopplerCorrectedHz(F, -3)).toBeGreaterThan(F);
  });

  it("lowers the observed frequency when receding (range rate > 0)", () => {
    expect(dopplerCorrectedHz(F, 3)).toBeLessThan(F);
  });

  it("is unshifted at zero range rate", () => {
    expect(dopplerCorrectedHz(F, 0)).toBe(F);
  });

  it("shifts by f·(rangeRate/c) in magnitude", () => {
    const rr = -3; // km/s
    const c = 299792.458;
    expect(dopplerCorrectedHz(F, rr)).toBeCloseTo(F * (1 - rr / c), 3);
  });
});

describe("formatFrequencyHz — MHz string at kHz precision", () => {
  it("formats a round downlink to three decimals", () => {
    expect(formatFrequencyHz(145_800_000)).toBe("145.800 MHz");
  });

  it("keeps a whole-MHz value padded to three decimals", () => {
    expect(formatFrequencyHz(437_000_000)).toBe("437.000 MHz");
  });

  it("rounds a Doppler-shifted value to kHz precision", () => {
    // ISS 2 m downlink closing at 3 km/s ⇒ ~+1.46 kHz. The sub-kHz remainder rounds away.
    const shifted = dopplerCorrectedHz(145_800_000, -3);
    expect(shifted).toBeGreaterThan(145_801_000);
    expect(formatFrequencyHz(shifted)).toBe("145.801 MHz");
  });

  it("rounds a receding shift the other way", () => {
    expect(formatFrequencyHz(dopplerCorrectedHz(145_800_000, 3))).toBe("145.799 MHz");
  });
});

describe("satGroupsFromSettings — toggles → enabled group set", () => {
  it("expands the amateur/stations toggle into both groups", () => {
    const g = satGroupsFromSettings({ amateurStations: true, weather: false, gnss: false });
    expect([...g].sort()).toEqual(["amateur", "stations"]);
  });

  it("adds weather and gnss independently", () => {
    expect([...satGroupsFromSettings({ amateurStations: false, weather: true, gnss: false })]).toEqual(
      ["weather"],
    );
    expect([...satGroupsFromSettings({ amateurStations: false, weather: false, gnss: true })]).toEqual(
      ["gnss"],
    );
  });

  it("returns all four groups when every toggle is on", () => {
    const g = satGroupsFromSettings({ amateurStations: true, weather: true, gnss: true });
    expect([...g].sort()).toEqual(["amateur", "gnss", "stations", "weather"]);
  });

  it("returns an empty set when every toggle is off", () => {
    expect(satGroupsFromSettings({ amateurStations: false, weather: false, gnss: false }).size).toBe(0);
  });
});

describe("buildSatrecs — corrupt OMM is dropped, not thrown", () => {
  it("keeps the good element sets and silently drops corrupt ones", () => {
    const empty = { noradId: 1, name: "empty", group: "amateur", omm: {} as SatelliteDto["omm"] };
    const badEcc: SatelliteDto = {
      noradId: 2,
      name: "bad-ecc",
      group: "amateur",
      // Eccentricity 5 is physically impossible (must be 0 ≤ e < 1) → satrec.error is set.
      omm: { ...ISS_OMM, ECCENTRICITY: 5 } as unknown as SatelliteDto["omm"],
    };
    let entries: ReturnType<typeof buildSatrecs> = [];
    expect(() => {
      entries = buildSatrecs([empty, issDto(), badEcc]);
    }).not.toThrow();
    expect(entries.map((e) => e.noradId)).toEqual([25544]);
  });
});

describe("clampEpochFraction — Hermes/Android date-parse compatibility", () => {
  // CelesTrak emits microsecond EPOCHs; json2satrec parses them with `new Date(EPOCH + "Z")`.
  // Hermes rejects >3 fractional digits (Invalid Date → NaN satrec → satellite silently dropped
  // on Android), while V8 — the engine running THIS test — parses leniently. So the honest seam
  // is the normalizer itself: buildSatrec must feed json2satrec a 3-digit fraction.
  it("truncates microsecond fractions to milliseconds", () => {
    expect(clampEpochFraction("2026-07-11T07:33:23.712192")).toBe("2026-07-11T07:33:23.712");
  });

  it("leaves millisecond and whole-second epochs untouched", () => {
    expect(clampEpochFraction("2026-07-11T07:33:23.712")).toBe("2026-07-11T07:33:23.712");
    expect(clampEpochFraction("2026-07-11T07:33:23")).toBe("2026-07-11T07:33:23");
  });

  it("buildSatrec still succeeds on a microsecond-precision EPOCH", () => {
    const rec = buildSatrec({ ...ISS_OMM, EPOCH: "2026-07-11T07:33:23.712192" } as unknown as SatelliteDto["omm"]);
    expect(rec).not.toBeNull();
  });
});
