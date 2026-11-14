import {
  MAX_TILT_DEG,
  SCOPE_PADDING_PX,
  boxAt,
  clampTilt,
  hitsBox,
  makeRadarProjection,
  polarToKm,
  projectPoint,
  r1,
  ringPath,
  unprojectGround,
} from "@/radar/projection";

const SIZE = 360;
const R = SIZE / 2 - SCOPE_PADDING_PX; // 162 px for the outer ring

describe("clampTilt", () => {
  it("rounds to whole degrees within [0, MAX_TILT_DEG]", () => {
    expect(clampTilt(12.4)).toBe(12);
    expect(clampTilt(12.6)).toBe(13);
    expect(clampTilt(-5)).toBe(0);
    expect(clampTilt(500)).toBe(MAX_TILT_DEG);
  });

  it("treats anything non-numeric or non-finite as flat", () => {
    expect(clampTilt(undefined)).toBe(0);
    expect(clampTilt("45")).toBe(0);
    expect(clampTilt(NaN)).toBe(0);
    expect(clampTilt(Infinity)).toBe(0);
  });
});

describe("makeRadarProjection / projectPoint — flat", () => {
  const flat = makeRadarProjection({ size: SIZE, rangeKm: 50, tiltDeg: 0, reliefMaxM: 2000 });

  it("is the classic top-down scope: R px for the range, north up, centred", () => {
    expect(flat.R).toBe(R);
    expect(projectPoint(flat, 0, 0)).toEqual({ x: 180, y: 180, s: 1 });
    expect(projectPoint(flat, 0, 50)).toMatchObject({ x: 180, y: 180 - R });
    expect(projectPoint(flat, 50, 0)).toMatchObject({ x: 180 + R, y: 180 });
    expect(projectPoint(flat, -25, -25)).toMatchObject({ x: 180 - R / 2, y: 180 + R / 2 });
  });

  it("ignores heights when flat, so the relief never shifts the flat picture", () => {
    expect(projectPoint(flat, 10, 20, 2500)).toEqual(projectPoint(flat, 10, 20, 0));
  });

  it("matches the old radar's bearing/distance placement exactly", () => {
    // The pre-tilt radar: x = cx + rr·sin(b), y = cy − rr·cos(b), rr = d / range · R.
    for (const [d, b] of [
      [12, 0],
      [30, 73],
      [49, 200],
      [5, 315],
    ]) {
      const { xKm, yKm } = polarToKm(d, b);
      const pt = projectPoint(flat, xKm, yKm);
      const rr = (d / 50) * R;
      expect(pt.x).toBeCloseTo(180 + rr * Math.sin((b * Math.PI) / 180), 9);
      expect(pt.y).toBeCloseTo(180 - rr * Math.cos((b * Math.PI) / 180), 9);
    }
  });
});

describe("makeRadarProjection / projectPoint — tilted", () => {
  const tilted = makeRadarProjection({ size: SIZE, rangeKm: 50, tiltDeg: 45, reliefMaxM: 1000 });

  it("foreshortens north–south and keeps north up", () => {
    const n = projectPoint(tilted, 0, 50);
    const s = projectPoint(tilted, 0, -50);
    expect(n.y).toBeLessThan(s.y);
    expect(s.y - n.y).toBeLessThan(2 * R * 0.9);
    expect(n.x).toBeCloseTo(180, 9);
    expect(s.x).toBeCloseTo(180, 9);
  });

  it("shrinks the far (north) side in perspective and keeps the near rim at the flat width", () => {
    const farW = projectPoint(tilted, 50, 40).x - projectPoint(tilted, -50, 40).x;
    const nearW = projectPoint(tilted, 50, -40).x - projectPoint(tilted, -50, -40).x;
    expect(farW).toBeLessThan(nearW);
    // The southern rim point is exactly as wide as flat (fit), so nothing spills past the box.
    expect(projectPoint(tilted, 0, -50).s).toBeCloseTo(1, 9);
    for (let a = 0; a < 360; a += 10) {
      const { xKm, yKm } = polarToKm(50, a);
      const pt = projectPoint(tilted, xKm, yKm);
      expect(pt.x).toBeGreaterThanOrEqual(180 - R - 1e-9);
      expect(pt.x).toBeLessThanOrEqual(180 + R + 1e-9);
    }
  });

  it("raises heights on screen, more the steeper the tilt", () => {
    const ground = projectPoint(tilted, 10, 10, 0);
    const peak = projectPoint(tilted, 10, 10, 1000);
    expect(peak.x).toBeCloseTo(ground.x, 9);
    expect(peak.y).toBeLessThan(ground.y);
    const steep = makeRadarProjection({ size: SIZE, rangeKm: 50, tiltDeg: 60, reliefMaxM: 1000 });
    const lift = (p: typeof tilted) => projectPoint(p, 0, 0, 0).y - projectPoint(p, 0, 0, 1000).y;
    expect(lift(steep)).toBeGreaterThan(lift(tilted));
  });

  it("bounds the relief exaggeration: flat country isn't blown up, high mountains don't explode", () => {
    const lift = (maxM: number) => {
      const p = makeRadarProjection({ size: SIZE, rangeKm: 50, tiltDeg: 45, reliefMaxM: maxM });
      return projectPoint(p, 0, 0, 0).y - projectPoint(p, 0, 0, maxM).y;
    };
    // A 150 m maximum rises far less than a 1 500 m one; above the cap the screen height stops growing
    // relative to the reference.
    expect(lift(150)).toBeLessThan(lift(1500) / 3);
    expect(lift(8000) / lift(2500)).toBeCloseTo(8000 / 2500, 6);
    expect(lift(2500)).toBeLessThan(R * 0.6);
  });
});

describe("unprojectGround", () => {
  it.each([0, 20, 45, 60])("inverts projectPoint on the ground at %i°", (tiltDeg) => {
    const p = makeRadarProjection({ size: SIZE, rangeKm: 25, tiltDeg });
    for (const [x, y] of [
      [0, 0],
      [10, -7],
      [-24, 3],
      [3, 24],
    ]) {
      const pt = projectPoint(p, x, y);
      const back = unprojectGround(p, pt.x, pt.y);
      expect(back!.xKm).toBeCloseTo(x, 6);
      expect(back!.yKm).toBeCloseTo(y, 6);
    }
  });

  it("returns null above the horizon of a steep tilt", () => {
    const p = makeRadarProjection({ size: SIZE, rangeKm: 25, tiltDeg: 60 });
    expect(unprojectGround(p, 180, -100000)).toBeNull();
  });
});

describe("tap targets under tilt", () => {
  it("centres a blip's box on its projected point, so a tap on the drawn blip hits it", () => {
    for (const tiltDeg of [0, 30, 60]) {
      const p = makeRadarProjection({ size: SIZE, rangeKm: 50, tiltDeg, reliefMaxM: 1500 });
      const pt = projectPoint(p, 20, 30, 800);
      const { left, top } = boxAt(pt, 24);
      expect(left + 12).toBeCloseTo(pt.x, 9);
      expect(top + 12).toBeCloseTo(pt.y, 9);
      expect(hitsBox(pt, 24, pt.x + 11, pt.y - 11)).toBe(true);
      expect(hitsBox(pt, 24, pt.x + 15, pt.y)).toBe(false);
      expect(hitsBox(pt, 24, pt.x + 15, pt.y, 6)).toBe(true);
    }
  });
});

describe("ringPath", () => {
  it("draws a closed polygon through the projected ring", () => {
    const p = makeRadarProjection({ size: SIZE, rangeKm: 50, tiltDeg: 30 });
    const d = ringPath(p, 50, 4);
    const n = projectPoint(p, 0, 50);
    expect(d.startsWith(`M${r1(n.x)} ${r1(n.y)}`)).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d.match(/L/g)).toHaveLength(3);
  });
});
