/**
 * Pure GeoJSON → map-coordinate conversion for the fishing overlays. This is the load-bearing logic
 * (the [lon,lat]→[lat,lng] swap and the defensive guards), so it's pinned here across all four geometry
 * types plus malformed input. Recall GeoJSON positions are [lon, lat]; the helpers emit Leaflet [lat, lng].
 */

import {
  lineLatLngs,
  pointLatLng,
  polygonRings,
  positionToLatLng,
  toLatLng,
  toLatLngs,
  type GeoGeometry,
} from "@/components/webmap/geojson";

describe("positionToLatLng", () => {
  it("swaps [lon, lat] to [lat, lng]", () => {
    expect(positionToLatLng([10, 60])).toEqual([60, 10]);
  });

  it("ignores a trailing altitude/measure element", () => {
    expect(positionToLatLng([10, 60, 123])).toEqual([60, 10]);
  });

  it("rejects malformed positions (short, non-numeric, non-finite, non-array)", () => {
    expect(positionToLatLng([10])).toBeNull();
    expect(positionToLatLng(["10", "60"])).toBeNull();
    expect(positionToLatLng([Number.NaN, 60])).toBeNull();
    expect(positionToLatLng([10, Infinity])).toBeNull();
    expect(positionToLatLng("nope")).toBeNull();
    expect(positionToLatLng(null)).toBeNull();
  });
});

describe("polygonRings — Polygon", () => {
  it("extracts the outer ring, swapping coordinate order", () => {
    const geom: GeoGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [10, 60],
          [11, 60],
          [11, 61],
          [10, 60],
        ],
      ],
    };
    expect(polygonRings(geom)).toEqual([
      {
        outer: [
          [60, 10],
          [60, 11],
          [61, 11],
          [60, 10],
        ],
        holes: [],
      },
    ]);
  });

  it("keeps hole rings (rings after the first)", () => {
    const geom: GeoGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 0],
        ],
        [
          [1, 1],
          [2, 1],
          [2, 2],
          [1, 1],
        ],
      ],
    };
    const [poly] = polygonRings(geom);
    expect(poly.outer).toHaveLength(4);
    expect(poly.holes).toHaveLength(1);
    expect(poly.holes[0][0]).toEqual([1, 1]);
  });

  it("drops malformed vertices but keeps the ring", () => {
    const geom: GeoGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [10, 60],
          [Number.NaN, 60],
          [11, 61],
        ],
      ],
    };
    expect(polygonRings(geom)[0].outer).toEqual([
      [60, 10],
      [61, 11],
    ]);
  });
});

describe("polygonRings — MultiPolygon", () => {
  it("returns one entry per member polygon", () => {
    const geom: GeoGeometry = {
      type: "MultiPolygon",
      coordinates: [
        [[[10, 60], [11, 60], [11, 61], [10, 60]]],
        [[[20, 70], [21, 70], [21, 71], [20, 70]]],
      ],
    };
    const polys = polygonRings(geom);
    expect(polys).toHaveLength(2);
    expect(polys[0].outer[0]).toEqual([60, 10]);
    expect(polys[1].outer[0]).toEqual([70, 20]);
  });
});

describe("lineLatLngs — LineString", () => {
  it("swaps each vertex", () => {
    const geom: GeoGeometry = {
      type: "LineString",
      coordinates: [
        [10, 60],
        [11, 61],
        [12, 62],
      ],
    };
    expect(lineLatLngs(geom)).toEqual([
      [60, 10],
      [61, 11],
      [62, 12],
    ]);
  });
});

describe("pointLatLng — Point", () => {
  it("swaps the single position", () => {
    expect(pointLatLng({ type: "Point", coordinates: [10, 60] })).toEqual([60, 10]);
  });
});

describe("cross-type guards", () => {
  it("polygonRings only accepts Polygon/MultiPolygon", () => {
    expect(polygonRings({ type: "LineString", coordinates: [[10, 60]] })).toEqual([]);
    expect(polygonRings({ type: "Point", coordinates: [10, 60] })).toEqual([]);
  });

  it("lineLatLngs only accepts LineString", () => {
    expect(lineLatLngs({ type: "Polygon", coordinates: [[[10, 60]]] })).toEqual([]);
  });

  it("pointLatLng only accepts Point", () => {
    expect(pointLatLng({ type: "Polygon", coordinates: [[[10, 60]]] })).toBeNull();
  });
});

describe("malformed / junk geometry", () => {
  it("returns empty for null/undefined and missing coordinates", () => {
    expect(polygonRings(null)).toEqual([]);
    expect(polygonRings(undefined)).toEqual([]);
    expect(polygonRings({ type: "Polygon" })).toEqual([]);
    expect(lineLatLngs(null)).toEqual([]);
    expect(pointLatLng(null)).toBeNull();
  });

  it("returns empty for non-array or nonsense coordinates", () => {
    expect(polygonRings({ type: "Polygon", coordinates: "nope" as unknown })).toEqual([]);
    expect(polygonRings({ type: "Polygon", coordinates: [[]] })).toEqual([]);
    expect(polygonRings({ type: "GeometryCollection", coordinates: [] })).toEqual([]);
    expect(lineLatLngs({ type: "LineString", coordinates: 42 as unknown })).toEqual([]);
    expect(pointLatLng({ type: "Point", coordinates: [] })).toBeNull();
  });

  it("skips MultiPolygon members whose outer ring is empty", () => {
    const geom: GeoGeometry = {
      type: "MultiPolygon",
      coordinates: [[[]], [[[10, 60], [11, 60], [11, 61], [10, 60]]]],
    };
    expect(polygonRings(geom)).toHaveLength(1);
  });
});

describe("toLatLng / toLatLngs (react-native-maps shape)", () => {
  it("maps a tuple to a {latitude, longitude} object", () => {
    expect(toLatLng([60, 10])).toEqual({ latitude: 60, longitude: 10 });
  });

  it("maps a run of tuples", () => {
    expect(
      toLatLngs([
        [60, 10],
        [61, 11],
      ]),
    ).toEqual([
      { latitude: 60, longitude: 10 },
      { latitude: 61, longitude: 11 },
    ]);
  });
});
