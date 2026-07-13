import { RADAR_RANGE_PRESETS, isAutoRange, zoomIn, zoomOut } from "@/components/radarRange";

// The auto-range argument only matters when the current range is Auto (0); pass a sentinel
// otherwise to prove the fixed-ladder stepping ignores it.
const IGNORED = 999;

describe("RADAR_RANGE_PRESETS", () => {
  it("lists Auto first then the fixed ranges largest → smallest", () => {
    expect(RADAR_RANGE_PRESETS).toEqual([0, 500, 250, 100, 50, 25, 10, 5, 2]);
  });

  it("uses 0 as the sole Auto sentinel; every other entry is a positive km value", () => {
    expect(RADAR_RANGE_PRESETS[0]).toBe(0);
    for (const p of RADAR_RANGE_PRESETS.slice(1)) expect(p).toBeGreaterThan(0);
  });
});

describe("isAutoRange", () => {
  it("treats 0, negatives and nullish as Auto", () => {
    expect(isAutoRange(0)).toBe(true);
    expect(isAutoRange(-5)).toBe(true);
    expect(isAutoRange(undefined)).toBe(true);
    expect(isAutoRange(null)).toBe(true);
  });

  it("treats any positive km as a fixed range", () => {
    expect(isAutoRange(2)).toBe(false);
    expect(isAutoRange(500)).toBe(false);
  });
});

describe("zoomIn from a fixed range", () => {
  it("steps to the next smaller fixed range", () => {
    expect(zoomIn(500, IGNORED)).toBe(250);
    expect(zoomIn(250, IGNORED)).toBe(100);
    expect(zoomIn(100, IGNORED)).toBe(50);
    expect(zoomIn(50, IGNORED)).toBe(25);
    expect(zoomIn(25, IGNORED)).toBe(10);
    expect(zoomIn(10, IGNORED)).toBe(5);
    expect(zoomIn(5, IGNORED)).toBe(2);
  });

  it("clamps at the innermost range (2 km stays 2 km)", () => {
    expect(zoomIn(2, IGNORED)).toBe(2);
  });
});

describe("zoomOut from a fixed range", () => {
  it("steps to the next larger fixed range", () => {
    expect(zoomOut(2, IGNORED)).toBe(5);
    expect(zoomOut(5, IGNORED)).toBe(10);
    expect(zoomOut(10, IGNORED)).toBe(25);
    expect(zoomOut(25, IGNORED)).toBe(50);
    expect(zoomOut(50, IGNORED)).toBe(100);
    expect(zoomOut(100, IGNORED)).toBe(250);
    expect(zoomOut(250, IGNORED)).toBe(500);
  });

  it("clamps at the outermost range (500 km stays 500 km)", () => {
    expect(zoomOut(500, IGNORED)).toBe(500);
  });
});

describe("zoomIn from Auto", () => {
  it("enters at the largest fixed range strictly below the auto range (visible zoom)", () => {
    // Auto fit ~25 km → first tap magnifies past the fit to the largest preset under it.
    expect(zoomIn(0, 25)).toBe(10);
    expect(zoomIn(0, 200)).toBe(100);
    expect(zoomIn(0, 40)).toBe(25);
  });

  it("steps in even when the auto range equals a preset (never a no-op)", () => {
    // Auto derived exactly 10 → must not pick 10 (no visible change); goes to 5.
    expect(zoomIn(0, 10)).toBe(5);
    expect(zoomIn(0, 50)).toBe(25);
  });

  it("caps at the outermost preset when the auto range exceeds every stop", () => {
    expect(zoomIn(0, 600)).toBe(500);
    expect(zoomIn(0, 5000)).toBe(500);
  });

  it("cannot zoom in past the innermost preset — stays Auto when the fit is already tiny", () => {
    // No preset below 2 km, so the first tap has nothing tighter to show.
    expect(zoomIn(0, 1.5)).toBe(0);
    expect(zoomIn(0, 2)).toBe(0);
  });
});

describe("zoomOut from Auto", () => {
  it("enters at the smallest fixed range strictly above the auto range", () => {
    expect(zoomOut(0, 25)).toBe(50);
    expect(zoomOut(0, 1.5)).toBe(2);
    expect(zoomOut(0, 10)).toBe(25);
  });

  it("stays Auto when the fit is already beyond the outermost preset", () => {
    expect(zoomOut(0, 600)).toBe(0);
  });
});

describe("ladder round-trips and full walks", () => {
  it("zoomOut undoes zoomIn on the interior of the ladder", () => {
    for (const km of [5, 10, 25, 50, 100, 250]) {
      expect(zoomOut(zoomIn(km, IGNORED), IGNORED)).toBe(km);
    }
  });

  it("walks the whole ladder inward and clamps", () => {
    const seen: number[] = [];
    let km = 500;
    for (let i = 0; i < 12; i++) {
      seen.push(km);
      km = zoomIn(km, IGNORED);
    }
    // Descends through every stop then pins at 2.
    expect(seen).toEqual([500, 250, 100, 50, 25, 10, 5, 2, 2, 2, 2, 2]);
  });

  it("walks the whole ladder outward and clamps", () => {
    const seen: number[] = [];
    let km = 2;
    for (let i = 0; i < 12; i++) {
      seen.push(km);
      km = zoomOut(km, IGNORED);
    }
    expect(seen).toEqual([2, 5, 10, 25, 50, 100, 250, 500, 500, 500, 500, 500]);
  });
});
