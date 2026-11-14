import {
  RIDGE_BEARING_STEP_DEG,
  dragBearing,
  dragDegPerPx,
  fromViewKm,
  isRotated,
  normalizeBearing,
  ridgeBearingFor,
  rimLabelBox,
  toViewKm,
} from "@/radar/rotation";
import {
  MAX_TILT_DEG,
  SCOPE_PADDING_PX,
  groundSquash,
  makeRadarProjection,
  polarToKm,
  projectPoint,
  reliefBoost,
  unprojectGround,
} from "@/radar/projection";

const SIZE = 360;
const R = SIZE / 2 - SCOPE_PADDING_PX;

describe("normalizeBearing", () => {
  it("wraps to whole degrees in [0, 360)", () => {
    expect(normalizeBearing(0)).toBe(0);
    expect(normalizeBearing(359.6)).toBe(0);
    expect(normalizeBearing(-45)).toBe(315);
    expect(normalizeBearing(725)).toBe(5);
    expect(normalizeBearing(12.4)).toBe(12);
    expect(Object.is(normalizeBearing(-360), 0)).toBe(true); // never −0
  });

  it("treats anything non-numeric or non-finite as north up", () => {
    expect(normalizeBearing(undefined)).toBe(0);
    expect(normalizeBearing("90")).toBe(0);
    expect(normalizeBearing(NaN)).toBe(0);
    expect(normalizeBearing(-Infinity)).toBe(0);
  });

  it("isRotated is false only north up", () => {
    expect(isRotated(0)).toBe(false);
    expect(isRotated(360)).toBe(false);
    expect(isRotated(1)).toBe(true);
  });
});

describe("dragBearing", () => {
  it("makes the far rim follow the finger: a drag of R·θ px turns the view by θ", () => {
    expect(dragDegPerPx(R)).toBeCloseTo(180 / (Math.PI * R), 12);
    const quarter = (Math.PI / 2) * R;
    // Dragged right, the picture turns clockwise, i.e. the view turns left.
    expect(dragBearing(0, quarter, R)).toBe(270);
    expect(dragBearing(0, -quarter, R)).toBe(90);
    expect(dragBearing(350, -((20 * Math.PI) / 180) * R, R)).toBe(10);
    expect(dragBearing(45, 0, R)).toBe(45);
  });

  it("never divides by a zero radius", () => {
    expect(Number.isFinite(dragBearing(0, 100, 0))).toBe(true);
  });
});

describe("view frame", () => {
  it("puts the view bearing up the screen", () => {
    const east = toViewKm(10, 0, 90);
    expect(east.x).toBeCloseTo(0, 9);
    expect(east.y).toBeCloseTo(10, 9);
    const north = toViewKm(0, 10, 90); // facing east, north is on the left
    expect(north.x).toBeCloseTo(-10, 9);
    expect(north.y).toBeCloseTo(0, 9);
  });

  it("fromViewKm inverts toViewKm, and both are exact identities north up", () => {
    for (const b of [0, 33, 90, 180, 271]) {
      const v = toViewKm(7, -3, b);
      const g = fromViewKm(v.x, v.y, b);
      expect(g.x).toBeCloseTo(7, 9);
      expect(g.y).toBeCloseTo(-3, 9);
    }
    expect(toViewKm(7, -3, 0)).toEqual({ x: 7, y: -3 });
    expect(fromViewKm(7, -3, 0)).toEqual({ x: 7, y: -3 });
  });

  it("snaps the ridge sampling bearing to the step", () => {
    expect(RIDGE_BEARING_STEP_DEG).toBe(5);
    expect(ridgeBearingFor(0)).toBe(0);
    expect(ridgeBearingFor(2)).toBe(0);
    expect(ridgeBearingFor(3)).toBe(5);
    expect(ridgeBearingFor(358)).toBe(0);
    expect(ridgeBearingFor(134)).toBe(135);
  });
});

describe("rimLabelBox", () => {
  it("centres an upright box a fixed gap outside the rim, away from the centre", () => {
    const origin = { x: 100, y: 100 };
    expect(rimLabelBox({ x: 100, y: 20 }, origin, 16, 10)).toEqual({ left: 92, top: 2 });
    expect(rimLabelBox({ x: 180, y: 100 }, origin, 16, 10)).toEqual({ left: 182, top: 92 });
  });
});

describe("rotated projection", () => {
  it("is bit-identical to the unrotated scope north up", () => {
    for (const tiltDeg of [0, 45, MAX_TILT_DEG]) {
      const plain = makeRadarProjection({ size: SIZE, rangeKm: 50, tiltDeg, reliefMaxM: 900 });
      const zero = makeRadarProjection({ size: SIZE, rangeKm: 50, tiltDeg, reliefMaxM: 900, bearingDeg: 0 });
      for (const [x, y, z] of [
        [12, -30, 0],
        [-40, 8, 500],
      ])
        expect(projectPoint(zero, x, y, z)).toEqual(projectPoint(plain, x, y, z));
    }
  });

  it("flat, turns every point about the centre: what lies at the view bearing goes to the top", () => {
    const p = makeRadarProjection({ size: SIZE, rangeKm: 50, tiltDeg: 0, bearingDeg: 120 });
    expect(p.bearingDeg).toBe(120);
    const ahead = polarToKm(50, 120);
    const top = projectPoint(p, ahead.xKm, ahead.yKm);
    expect(top.x).toBeCloseTo(SIZE / 2, 9);
    expect(top.y).toBeCloseTo(SIZE / 2 - R, 9);
    // North is 120° anticlockwise from the top.
    const n = projectPoint(p, 0, 50);
    expect(n.x).toBeCloseTo(SIZE / 2 - R * Math.sin((120 * Math.PI) / 180), 9);
    expect(n.y).toBeCloseTo(SIZE / 2 - R * Math.cos((120 * Math.PI) / 180), 9);
    // The observer stays at the centre.
    expect(projectPoint(p, 0, 0)).toMatchObject({ x: SIZE / 2, y: SIZE / 2 });
  });

  it("tilted, leans towards the bottom of the screen whatever the bearing", () => {
    for (const b of [0, 45, 200]) {
      const p = makeRadarProjection({ size: SIZE, rangeKm: 50, tiltDeg: 50, bearingDeg: b });
      const far = polarToKm(50, b);
      const near = polarToKm(50, b + 180);
      // The far rim (up the screen) is smaller than the near one, and straight above the centre.
      expect(projectPoint(p, far.xKm, far.yKm).s).toBeLessThan(projectPoint(p, near.xKm, near.yKm).s);
      expect(projectPoint(p, far.xKm, far.yKm).x).toBeCloseTo(SIZE / 2, 9);
    }
  });

  it.each([0, 30, 60, 80])("unprojectGround inverts the turned projection at %i°", (tiltDeg) => {
    const p = makeRadarProjection({ size: SIZE, rangeKm: 25, tiltDeg, bearingDeg: 137 });
    for (const [x, y] of [
      [0, 0],
      [10, -7],
      [-24, 3],
    ]) {
      const pt = projectPoint(p, x, y);
      const back = unprojectGround(p, pt.x, pt.y);
      expect(back!.xKm).toBeCloseTo(x, 6);
      expect(back!.yKm).toBeCloseTo(y, 6);
    }
  });
});

describe("steep tilts", () => {
  it("allows up to 80°", () => {
    expect(MAX_TILT_DEG).toBe(80);
  });

  it("is the true cos t squash up to 60°, then eases so the disc never becomes a thin strip", () => {
    for (const t of [0, 30, 45, 60]) {
      expect(groundSquash(t)).toBeCloseTo(Math.cos((t * Math.PI) / 180), 12);
      expect(reliefBoost(t)).toBe(1);
    }
    expect(groundSquash(MAX_TILT_DEG)).toBeCloseTo(0.3, 9);
    expect(groundSquash(MAX_TILT_DEG)).toBeGreaterThan(Math.cos((MAX_TILT_DEG * Math.PI) / 180));
    // Still flattening with every degree, and the relief growing.
    for (let t = 61; t <= MAX_TILT_DEG; t++) {
      expect(groundSquash(t)).toBeLessThan(groundSquash(t - 1));
      expect(reliefBoost(t)).toBeGreaterThan(reliefBoost(t - 1));
    }
    expect(reliefBoost(MAX_TILT_DEG)).toBeCloseTo(1.5, 9);
  });

  it("raises the relief more at the steepest tilt than at 60°", () => {
    const lift = (tiltDeg: number) => {
      const p = makeRadarProjection({ size: SIZE, rangeKm: 50, tiltDeg, reliefMaxM: 1000 });
      return projectPoint(p, 0, 0, 0).y - projectPoint(p, 0, 0, 1000).y;
    };
    expect(lift(MAX_TILT_DEG)).toBeGreaterThan(lift(60) * 1.4);
  });
});
