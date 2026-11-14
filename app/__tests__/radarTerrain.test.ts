import { clipLineToCircle, contourLines } from "@/radar/contours";
import { makeRadarProjection } from "@/radar/projection";
import { roundCentre, shouldRefetchTerrain, terrainRadiusFor } from "@/radar/terrainFetch";
import {
  COAST_LEVEL_M,
  MAX_RIDGE_POINTS,
  MAX_RIDGE_ROWS,
  buildTerrainGeometry,
  ridgeRowsFor,
  smoothLand,
} from "@/radar/terrainGeometry";
import {
  TERRAIN_ATTRIBUTION,
  gridMaxM,
  gridOffsetKm,
  heightAtKm,
  toTerrainGrid,
  type TerrainGrid,
} from "@/radar/terrainGrid";
import { terrainPaths } from "@/radar/terrainPaths";
import demoTerrain from "@/mock/demo-terrain.json";

/** A size × size grid from f(x, y) in km (x east, y north of the centre). */
function makeGrid(size: number, cellKm: number, f: (x: number, y: number) => number): TerrainGrid {
  const half = (size - 1) / 2;
  const heights: number[] = [];
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) heights.push(f((c - half) * cellKm, (half - r) * cellKm));
  return toTerrainGrid({ lat: 60, lon: 10, radiusKm: half * cellKm, cellKm, size, heights, attribution: "x" })!;
}

/** A round island of radius `islandKm` with a cone-shaped mountain `peakM` high in the middle. */
const island = (islandKm: number, peakM: number) => (x: number, y: number) => {
  const d = Math.hypot(x, y);
  return d < islandKm ? Math.max(10, peakM * (1 - d / islandKm)) : 0;
};


describe("toTerrainGrid", () => {
  it("accepts the endpoint payload and clamps negative / junk heights to sea", () => {
    const g = toTerrainGrid({ lat: 1, lon: 2, cellKm: 1, size: 2, heights: [0, -5, 120, NaN as unknown as number] });
    expect(g).not.toBeNull();
    expect(Array.from(g!.heights)).toEqual([0, 0, 120, 0]);
    expect(g!.attribution).toBe(TERRAIN_ATTRIBUTION);
    expect(g!.radiusKm).toBe(0.5);
  });

  it("rejects an empty grid (no DB on the server) and malformed payloads", () => {
    expect(toTerrainGrid(null)).toBeNull();
    expect(toTerrainGrid({ lat: 1, lon: 2, cellKm: 1, size: 0, heights: [] })).toBeNull();
    expect(toTerrainGrid({ lat: 1, lon: 2, cellKm: 1, size: 3, heights: [1, 2, 3] })).toBeNull();
    expect(toTerrainGrid({ lat: 1, lon: 2, cellKm: 0, size: 2, heights: [0, 0, 0, 0] })).toBeNull();
    expect(toTerrainGrid({ lon: 2, cellKm: 1, size: 2, heights: [0, 0, 0, 0] })).toBeNull();
  });

  it("validates the bundled demo sample: real relief around the demo home, sea and hills", () => {
    const g = toTerrainGrid(demoTerrain);
    expect(g).not.toBeNull();
    expect(g!.size).toBe(129);
    expect(Array.from(g!.heights)).toContain(0); // the Oslofjord
    expect(gridMaxM(g!)).toBeGreaterThan(500);
  });
});

describe("heightAtKm / gridOffsetKm", () => {
  const g = makeGrid(5, 1, (x, y) => 100 + 10 * x + y);

  it("interpolates bilinearly between cells and is 0 off the grid", () => {
    expect(heightAtKm(g, { dx: 0, dy: 0 }, 0, 0)).toBeCloseTo(100, 9);
    expect(heightAtKm(g, { dx: 0, dy: 0 }, 0.5, 0.5)).toBeCloseTo(105.5, 9);
    expect(heightAtKm(g, { dx: 0, dy: 0 }, 2, -2)).toBeCloseTo(118, 9);
    expect(heightAtKm(g, { dx: 0, dy: 0 }, 2.1, 0)).toBe(0);
  });

  it("follows the grid when the observer has moved off its centre", () => {
    expect(heightAtKm(g, { dx: 1, dy: 0 }, 1, 0)).toBeCloseTo(100, 9);
  });

  it("puts a grid centred north-east of the observer at positive x and y", () => {
    expect(gridOffsetKm(g, { lat: 60, lon: 10 })).toEqual({ dx: 0, dy: 0 });
    const o = gridOffsetKm(g, { lat: 59.9, lon: 9.9 });
    expect(o.dy).toBeCloseTo(11.1, 0);
    expect(o.dx).toBeCloseTo(5.6, 0);
  });
});

describe("contourLines", () => {
  it("closes the iso-line around a single peak, through the interpolated crossings", () => {
    // 3×3 with a 100 m centre: the 50 m line crosses each edge midway between the centre and its neighbour.
    const lines = contourLines([0, 0, 0, 0, 100, 0, 0, 0, 0], 3, 50);
    expect(lines).toHaveLength(1);
    const l = lines[0];
    expect(l.slice(0, 2)).toEqual(l.slice(-2)); // closed
    const pts: [number, number][] = [];
    for (let i = 0; i < l.length - 2; i += 2) pts.push([l[i], l[i + 1]]);
    expect(pts).toHaveLength(4);
    for (const [x, y] of pts) expect(Math.abs(x - 1) + Math.abs(y - 1)).toBeCloseTo(0.5, 9);
  });

  it("leaves a line that runs off the grid open and chains it into one polyline", () => {
    // West half land, east half sea: one north–south coastline from edge to edge.
    const n = 6;
    const v: number[] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) v.push(c < 3 ? 100 : 0);
    const lines = contourLines(v, n, COAST_LEVEL_M);
    expect(lines).toHaveLength(1);
    expect(lines[0].length / 2).toBe(n);
    const ys = lines[0].filter((_, i) => i % 2 === 1).sort((a, b) => a - b);
    expect(ys[0]).toBe(0);
    expect(ys[ys.length - 1]).toBe(n - 1);
    for (let i = 0; i < lines[0].length; i += 2) expect(lines[0][i]).toBeCloseTo(2 + 95 / 100, 9);
  });

  it("resolves saddles by the cell centre", () => {
    // Diagonal highs: centre average 50 ≥ 40 joins them (two lines cutting off the low corners) …
    expect(contourLines([100, 0, 0, 100], 2, 40)).toHaveLength(2);
    // … and centre 50 < 60 separates them (two lines around the high corners).
    const sep = contourLines([100, 0, 0, 100], 2, 60);
    expect(sep).toHaveLength(2);
    // Around the high corners each line stays near its corner (x + y ≈ small for the top-left one).
    const tl = sep.find((l) => l[0] + l[1] < 1)!;
    expect(tl).toBeDefined();
  });

  it("is empty for a flat grid or a level outside the data", () => {
    expect(contourLines(new Array(16).fill(10), 4, 5)).toEqual([]);
    expect(contourLines(new Array(16).fill(10), 4, 50)).toEqual([]);
    expect(contourLines([], 0, 5)).toEqual([]);
  });
});

describe("clipLineToCircle", () => {
  it("keeps an inside line whole", () => {
    expect(clipLineToCircle([0, 0, 1, 1, 2, 0], 5)).toEqual([[0, 0, 1, 1, 2, 0]]);
  });

  it("cuts where a line leaves and re-enters, exactly on the circle", () => {
    const parts = clipLineToCircle([-10, 0, 0, 0, 10, 0, 10, 5, 0, 3], 5);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual([-5, 0, 0, 0, 5, 0]);
    const [x, y] = parts[1];
    expect(Math.hypot(x, y)).toBeCloseTo(5, 9);
    expect(parts[1].slice(-2)).toEqual([0, 3]);
  });

  it("keeps the chord of a segment that passes through with both ends outside", () => {
    const parts = clipLineToCircle([-10, 3, 10, 3], 5);
    expect(parts).toHaveLength(1);
    expect(parts[0][0]).toBeCloseTo(-4, 9);
    expect(parts[0][2]).toBeCloseTo(4, 9);
    expect(clipLineToCircle([-10, 8, 10, 8], 5)).toEqual([]);
  });
});

describe("ridgeRowsFor", () => {
  it("keeps about 4.5 px of radius per row, in steps of 4, within [16, MAX_RIDGE_ROWS]", () => {
    expect(ridgeRowsFor(162)).toBe(36);
    expect(ridgeRowsFor(40)).toBe(16);
    expect(ridgeRowsFor(2000)).toBe(MAX_RIDGE_ROWS);
    expect(ridgeRowsFor(160) % 4).toBe(0);
  });
});

describe("smoothLand", () => {
  it("averages land cells over their land neighbours and leaves the sea at 0", () => {
    const s = smoothLand([0, 0, 0, 0, 90, 30, 0, 30, 30], 3);
    expect(s[0]).toBe(0);
    expect(s[4]).toBeCloseTo((90 + 30 + 30 + 30) / 4, 9);
    expect(s[8]).toBeCloseTo((90 + 30 + 30 + 30) / 4, 9);
  });
});

describe("buildTerrainGeometry", () => {
  const g = makeGrid(65, 1, island(20, 1000)); // ±32 km, a 20 km island with a 1 000 m peak

  it("traces the coastline at the island edge, inside the scope disc", () => {
    const geom = buildTerrainGeometry(g, { dx: 0, dy: 0 }, 30);
    expect(geom.maxM).toBe(1000);
    const coast = geom.coast.flat();
    expect(coast.length).toBeGreaterThan(0);
    for (let i = 0; i < coast.length; i += 2) expect(Math.hypot(coast[i], coast[i + 1])).toBeCloseTo(20, 0);
    expect(geom.capped).toBe(false);
  });

  it("clips the coastline to a smaller scope and reports the highest point in view", () => {
    const geom = buildTerrainGeometry(g, { dx: 0, dy: 0 }, 10);
    expect(geom.coast).toEqual([]); // the coast is 20 km out
    expect(geom.maxM).toBe(1000);
    expect(buildTerrainGeometry(g, { dx: 0, dy: 0 }, 30).land.length).toBeGreaterThan(0);
  });

  it("tints the land as row runs within the island and the disc", () => {
    const r = buildTerrainGeometry(g, { dx: 0, dy: 0 }, 30).land;
    expect(r.length % 4).toBe(0);
    for (let i = 0; i < r.length; i += 4) {
      expect(r[i]).toBeLessThan(r[i + 1]);
      expect(r[i + 2]).toBeGreaterThan(r[i + 3]);
      expect(Math.hypot(Math.max(Math.abs(r[i]), Math.abs(r[i + 1])), (r[i + 2] + r[i + 3]) / 2)).toBeLessThan(21);
    }
  });

  it("profiles the land north to south, over land only, peaking at the summit", () => {
    const geom = buildTerrainGeometry(g, { dx: 0, dy: 0 }, 30, { ridgeRows: 20 });
    const ys = geom.ridges.map((row) => row.yKm);
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
    // Rows only where the island is (|y| < 20), and each run stays on the island.
    for (const row of geom.ridges) {
      expect(Math.abs(row.yKm)).toBeLessThan(20.5);
      for (const run of row.runs)
        for (let i = 0; i < run.length; i += 2) expect(Math.hypot(run[i], row.yKm)).toBeLessThan(21);
    }
    // The middle row rises to near the peak at x ≈ 0 and falls off towards the coast.
    const mid = geom.ridges.reduce((a, b) => (Math.abs(b.yKm) < Math.abs(a.yKm) ? b : a));
    const run = mid.runs[0];
    const hs = run.filter((_, i) => i % 2 === 1);
    const top = Math.max(...hs);
    expect(top).toBeGreaterThan(800);
    expect(Math.abs(run[2 * hs.indexOf(top)])).toBeLessThan(3);
    expect(hs[0]).toBeLessThan(top / 2);
  });

  it("leaves a gap in a profile where it crosses water", () => {
    // Two islands either side of a 6 km sound running north–south.
    const sound = makeGrid(65, 1, (x) => (Math.abs(x) > 3 && Math.abs(x) < 25 ? 300 : 0));
    const geom = buildTerrainGeometry(sound, { dx: 0, dy: 0 }, 30, { ridgeRows: 10 });
    const mid = geom.ridges.reduce((a, b) => (Math.abs(b.yKm) < Math.abs(a.yKm) ? b : a));
    expect(mid.runs).toHaveLength(2);
    expect(mid.runs[0][mid.runs[0].length - 2]).toBeLessThan(-2.5);
    expect(mid.runs[1][0]).toBeGreaterThan(2.5);
  });

  it("shifts everything by the observer offset from the grid centre", () => {
    const geom = buildTerrainGeometry(g, { dx: 5, dy: 0 }, 30);
    const coast = geom.coast.flat();
    let sx = 0;
    for (let i = 0; i < coast.length; i += 2) sx += coast[i];
    expect(sx / (coast.length / 2)).toBeGreaterThan(2); // the island now sits east of the observer
  });

  it("stays within the point and rectangle caps on dense terrain", () => {
    // A noisy fjord-like coast at every cell: lots of tiny islands.
    const noisy = makeGrid(129, 1, (x, y) =>
      Math.sin(x * 1.7) * Math.cos(y * 1.3) > 0.1 ? 50 + 30 * (x + y + 200) : 0,
    );
    const geom = buildTerrainGeometry(noisy, { dx: 0, dy: 0 }, 64, {
      maxRidgePoints: 1500,
      maxCoastPoints: 2000,
      maxLandRects: 800,
    });
    expect(geom.capped).toBe(true);
    const ridgePoints = geom.ridges.reduce((s, row) => s + row.runs.reduce((a, r) => a + r.length / 2, 0), 0);
    expect(ridgePoints).toBeLessThanOrEqual(1500);
    expect(geom.coast.reduce((s, l) => s + l.length / 2, 0)).toBeLessThanOrEqual(2000 + 2 * geom.coast.length);
    expect(geom.land.length / 4).toBeLessThanOrEqual(800);
  });

  it("builds the real demo grid within the default caps: the Oslofjord coast and hills", () => {
    const demo = toTerrainGrid(demoTerrain)!;
    for (const range of [25, 50, 100]) {
      const geom = buildTerrainGeometry(demo, { dx: 0, dy: 0 }, range);
      expect(geom.coast.length).toBeGreaterThan(0);
      expect(geom.ridges.length).toBeGreaterThan(10);
      expect(geom.maxM).toBeGreaterThan(range >= 50 ? 400 : 100);
      const ridgePoints = geom.ridges.reduce((s, row) => s + row.runs.reduce((a, r) => a + r.length / 2, 0), 0);
      expect(ridgePoints).toBeLessThanOrEqual(MAX_RIDGE_POINTS);
    }
  });
});

describe("terrainPaths", () => {
  const g = makeGrid(65, 1, island(20, 1000));
  const geom = buildTerrainGeometry(g, { dx: 0, dy: 0 }, 30, { ridgeRows: 20 });
  const at = (tiltDeg: number) =>
    terrainPaths(geom, makeRadarProjection({ size: 360, rangeKm: 30, tiltDeg, reliefMaxM: geom.maxM }));
  const ysOf = (d: string) => [...d.matchAll(/[ML][-\d.]+ ([-\d.]+)/g)].map((m) => Number(m[1]));

  it("emits the land, the coast and a silhouette + profile per ridge row, far to near", () => {
    const paths = at(40);
    expect(paths.land).toMatch(/^M[-\d.]+ [-\d.]+L/);
    expect(paths.coast).toMatch(/^M[-\d.]+ [-\d.]+L/);
    expect(paths.ridges).toHaveLength(geom.ridges.length);
    expect(paths.ridges[0].depth).toBe(0);
    expect(paths.ridges[paths.ridges.length - 1].depth).toBe(1);
    for (const r of paths.ridges) {
      expect(r.fill.endsWith("Z")).toBe(true);
      expect(r.stroke).not.toContain("Z");
    }
  });

  it("raises the profiles when tilted, but not when flat", () => {
    const flat = at(0);
    const tilted = at(60);
    const fm = flat.ridges[Math.floor(flat.ridges.length / 2)];
    const tm = tilted.ridges[Math.floor(tilted.ridges.length / 2)];
    // Flat: the profile is a straight line on its row (all points share one screen y).
    const ys = ysOf(fm.stroke);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.2);
    // Tilted: the summit stands well above the row's sea-level baseline.
    expect(Math.max(...ysOf(tm.fill)) - Math.min(...ysOf(tm.stroke))).toBeGreaterThan(15);
  });
});

describe("terrain fetch policy", () => {
  it("snaps the request radius to a ladder above the range", () => {
    expect(terrainRadiusFor(2)).toBe(10);
    expect(terrainRadiusFor(25)).toBe(35);
    expect(terrainRadiusFor(50)).toBe(75);
    expect(terrainRadiusFor(100)).toBe(150);
    expect(terrainRadiusFor(250)).toBe(350);
    expect(terrainRadiusFor(500)).toBe(500);
  });

  const here = { lat: 60, lon: 10 };
  const fetched = { lat: 60, lon: 10, radiusKm: 100 };

  it("fetches when there is nothing yet", () => {
    expect(shouldRefetchTerrain(null, here, 50)).toBe(true);
  });

  it("keeps the grid for small moves and nearby ranges", () => {
    expect(shouldRefetchTerrain(fetched, here, 50)).toBe(false);
    expect(shouldRefetchTerrain(fetched, { lat: 60.1, lon: 10 }, 50)).toBe(false); // 11 km
    expect(shouldRefetchTerrain(fetched, here, 60)).toBe(false);
  });

  it("refetches after moving a fifth of the grid radius, zooming out past it or zooming far in", () => {
    expect(shouldRefetchTerrain(fetched, { lat: 60.2, lon: 10 }, 50)).toBe(true); // 22 km
    expect(shouldRefetchTerrain(fetched, here, 100)).toBe(true); // wants 150
    expect(shouldRefetchTerrain(fetched, here, 10)).toBe(true); // wants 20: too coarse
  });

  it("never loops at the largest radius", () => {
    expect(shouldRefetchTerrain({ lat: 60, lon: 10, radiusKm: 500 }, { lat: 60.004, lon: 10.004 }, 500)).toBe(false);
  });

  it("rounds request centres to 0.01°", () => {
    expect(roundCentre(59.91437)).toBe(59.91);
    expect(roundCentre(-0.005001)).toBe(-0.01);
  });
});
