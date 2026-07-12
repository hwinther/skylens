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
  buildSatrecs,
  dopplerCorrectedHz,
  formatFrequencyHz,
  GROUP_PRIORITY,
  propagateAll,
  satGroupsFromSettings,
  SATELLITE_RENDER_CAP,
  selectVisible,
  type SatelliteView,
  type SatGroup,
} from "@/ar/satellites";
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

/** Fabricate a bare SatelliteView for selection tests (no propagation involved). */
function view(noradId: number, group: SatGroup, elevationDeg: number): SatelliteView {
  return {
    noradId,
    name: `sat-${noradId}`,
    group,
    azimuthDeg: 180,
    elevationDeg,
    rangeKm: 1000,
    rangeRateKmS: 0,
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
