/**
 * The Map's satellites-layer policy (src/components/webmap/satelliteLayer), shared by the native and
 * web maps: markers are the Overhead set at sub-satellite points, the tracked marker steps aside when
 * the layer already draws that satellite, and exactly one satellite gets a footprint.
 */

import type { SatelliteView } from "@/ar";
import { overheadSatellites } from "@/ar";
import {
  footprintSatellite,
  mapSatellites,
  satelliteFootprint,
  satelliteShortName,
  SAT_LABEL_MAX_CHARS,
  showTrackedMarker,
} from "@/components/webmap/satelliteLayer";

function view(noradId: number, over: Partial<SatelliteView> = {}): SatelliteView {
  return {
    noradId,
    name: `SAT ${noradId}`,
    group: "amateur",
    azimuthDeg: 180,
    elevationDeg: 30,
    azimuthRateDegS: 0,
    elevationRateDegS: 0,
    rangeKm: 1000,
    rangeRateKmS: 0,
    subLat: 50,
    subLon: 10,
    altKm: 500,
    ...over,
  };
}

describe("satelliteShortName", () => {
  it("drops the parenthesised alias", () => {
    expect(satelliteShortName("ISS (ZARYA)")).toBe("ISS");
    expect(satelliteShortName("NAVSTAR 81 (USA 319)")).toBe("NAVSTAR 81");
    expect(satelliteShortName("GPS BIIR-5  (PRN 22)")).toBe("GPS BIIR-5");
  });

  it("keeps a name that is only an alias, and trims", () => {
    expect(satelliteShortName("(ODD)")).toBe("(ODD)");
    expect(satelliteShortName("  NOAA 19 ")).toBe("NOAA 19");
  });

  it("cuts long names with an ellipsis", () => {
    const s = satelliteShortName("A VERY LONG SATELLITE NAME INDEED");
    expect(s).toHaveLength(SAT_LABEL_MAX_CHARS);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("mapSatellites", () => {
  const visible = [
    view(1, { elevationDeg: 10, subLat: 1, subLon: 2 }),
    view(2, { elevationDeg: 70, name: "ISS (ZARYA)" }),
    view(3, { elevationDeg: 40 }),
  ];

  it("is the Overhead set, in the List's order, at the sub-satellite points", () => {
    const markers = mapSatellites(visible, true);
    expect(markers.map((m) => m.noradId)).toEqual(overheadSatellites(visible).map((v) => v.noradId));
    expect(markers.map((m) => m.noradId)).toEqual([2, 3, 1]);
    expect(markers[0]).toEqual({ noradId: 2, name: "ISS (ZARYA)", label: "ISS", lat: 50, lon: 10 });
    expect(markers[2]).toMatchObject({ lat: 1, lon: 2 });
  });

  it("is empty with the layer off", () => {
    expect(mapSatellites(visible, false)).toEqual([]);
  });
});

describe("showTrackedMarker", () => {
  const markers = mapSatellites([view(25544)], true);

  it("steps aside when the layer already draws the tracked satellite", () => {
    expect(showTrackedMarker(25544, markers)).toBe(false);
  });

  it("stays for a tracked satellite that is not overhead, or with the layer off", () => {
    expect(showTrackedMarker(99999, markers)).toBe(true);
    expect(showTrackedMarker(25544, [])).toBe(true);
  });

  it("is off with nothing tracked", () => {
    expect(showTrackedMarker(null, markers)).toBe(false);
  });
});

describe("footprintSatellite", () => {
  const byId = new Map([
    [1, view(1)],
    [2, view(2)],
    [3, view(3, { altKm: undefined })],
  ]);

  it("prefers the open card's satellite, then the tracked one", () => {
    expect(footprintSatellite(1, 2, byId)?.noradId).toBe(1);
    expect(footprintSatellite(null, 2, byId)?.noradId).toBe(2);
    // The selected one is not overhead any more: fall back to the tracked one.
    expect(footprintSatellite(42, 2, byId)?.noradId).toBe(2);
  });

  it("needs an overhead satellite with a known height", () => {
    expect(footprintSatellite(null, null, byId)).toBeNull();
    expect(footprintSatellite(42, 43, byId)).toBeNull();
    expect(footprintSatellite(3, null, byId)).toBeNull();
  });
});

describe("satelliteFootprint", () => {
  it("draws the 0° footprint around the sub-point, or nothing", () => {
    const fp = satelliteFootprint(view(1, { altKm: 420 }));
    expect(fp?.radiusKm).toBeGreaterThan(2200);
    expect(fp?.radiusKm).toBeLessThan(2300);
    expect(satelliteFootprint(null)).toBeNull();
    expect(satelliteFootprint(view(1, { altKm: undefined }))).toBeNull();
  });
});
