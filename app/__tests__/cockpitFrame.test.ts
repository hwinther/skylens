import { isRotorcraft } from "@/aircraft/aircraftType";
import {
  COCKPIT_FRAME_VARIANTS,
  frameGeometry,
  frameOverscan,
  frameParallax,
  framePostPx,
  frameVariant,
  FRAME_SIDE_OPACITY,
  roundedPolygon,
} from "@/sim/cockpitFrame";
import { aircraftSample, AIRCRAFT_PITCH_DEG, HELICOPTER_PITCH_DEG } from "@/sim/simPose";

describe("frameVariant", () => {
  it("gives aircraft an aeroplane or helicopter frame by the type table, else the emitter category", () => {
    expect(frameVariant("aircraft", { t: "B738" })).toBe("aeroplane");
    expect(frameVariant("aircraft", { t: "EC35" })).toBe("helicopter");
    // The type wins over a wrong category …
    expect(frameVariant("aircraft", { t: "B738", cat: "A7" })).toBe("aeroplane");
    expect(frameVariant("aircraft", { t: "EC35", cat: "A3" })).toBe("helicopter");
    // … and the category decides when the type is unknown.
    expect(frameVariant("aircraft", { cat: "A7" })).toBe("helicopter");
    expect(frameVariant("aircraft", { t: "ZZZZ", cat: "A7" })).toBe("helicopter");
    expect(frameVariant("aircraft", { cat: "A3" })).toBe("aeroplane");
    // Not in the store (yet): an aeroplane.
    expect(frameVariant("aircraft", null)).toBe("aeroplane");
    expect(frameVariant("aircraft")).toBe("aeroplane");
  });

  it("gives vessels the bridge and satellites no frame", () => {
    expect(frameVariant("vessel")).toBe("vessel");
    expect(frameVariant("satellite")).toBeNull();
  });

  it("uses the same rotor rule as the cockpit camera's helicopter pitch", () => {
    for (const ac of [{ t: "EC35" }, { t: "B738", cat: "A7" }, { cat: "A7" }, { cat: "A1" }, {}]) {
      const sample = aircraftSample({ hex: "abc", lat: 60, lon: 10, ...ac }, 0);
      const heli = frameVariant("aircraft", ac) === "helicopter";
      expect(heli).toBe(isRotorcraft(ac));
      expect(sample?.basePitchDeg).toBe(heli ? HELICOPTER_PITCH_DEG : AIRCRAFT_PITCH_DEG);
    }
  });
});

describe("frameParallax", () => {
  const W = 412;
  const H = 915;
  const o = frameOverscan(W, H);

  it("sits at rest looking straight ahead", () => {
    expect(frameParallax({ yaw: 0, pitch: 0 }, W, H)).toEqual({ x: 0, y: 0, opacity: 1 });
  });

  it("slides opposite to the look: right → left, up → down", () => {
    const right = frameParallax({ yaw: 40, pitch: 0 }, W, H);
    expect(right.x).toBeLessThan(0);
    expect(right.y).toBe(0);
    const left = frameParallax({ yaw: -40, pitch: 0 }, W, H);
    expect(left.x).toBeCloseTo(-right.x, 5);
    const up = frameParallax({ yaw: 0, pitch: 20 }, W, H);
    expect(up.y).toBeGreaterThan(0);
    expect(frameParallax({ yaw: 0, pitch: -20 }, W, H).y).toBeCloseTo(-up.y, 5);
  });

  it("grows with the angle but never past the overscan, so no canvas edge shows", () => {
    let prev = 0;
    for (const yaw of [5, 15, 30, 45, 60, 90, 120, 179]) {
      const { x } = frameParallax({ yaw, pitch: 0 }, W, H);
      expect(-x).toBeGreaterThan(prev);
      expect(Math.abs(x)).toBeLessThanOrEqual(o.x);
      prev = -x;
    }
    for (const pitch of [-90, -80, 80, 90, 400]) {
      expect(Math.abs(frameParallax({ yaw: 0, pitch }, W, H).y)).toBeLessThanOrEqual(o.y);
    }
    // About 40° right moves it most of the way (a side post comes into view on a phone).
    expect(-frameParallax({ yaw: 40, pitch: 0 }, W, H).x).toBeGreaterThan(0.7 * o.x);
  });

  it("stays fully drawn ahead, dims looking far to the side and is gone looking behind", () => {
    expect(frameParallax({ yaw: 45, pitch: 0 }, W, H).opacity).toBe(1);
    const side = frameParallax({ yaw: 120, pitch: 0 }, W, H).opacity;
    expect(side).toBeCloseTo(FRAME_SIDE_OPACITY, 5);
    expect(frameParallax({ yaw: 90, pitch: 0 }, W, H).opacity).toBeGreaterThan(side);
    expect(frameParallax({ yaw: 90, pitch: 0 }, W, H).opacity).toBeLessThan(1);
    expect(frameParallax({ yaw: 170, pitch: 0 }, W, H).opacity).toBe(0);
    // Wrapped angles behave the same (−190° is 170°).
    expect(frameParallax({ yaw: -190, pitch: 0 }, W, H)).toEqual(frameParallax({ yaw: 170, pitch: 0 }, W, H));
  });

  it("ignores a non-finite offset", () => {
    expect(frameParallax({ yaw: Number.NaN, pitch: Number.POSITIVE_INFINITY }, W, H)).toEqual({ x: 0, y: 0, opacity: 1 });
  });
});

describe("frameGeometry", () => {
  const SIZES: [number, number][] = [
    [412, 915],
    [915, 412],
    [1400, 900],
  ];

  it("covers the screen plus the overscan, with the canvas placed at minus the overscan", () => {
    for (const variant of COCKPIT_FRAME_VARIANTS) {
      for (const [w, h] of SIZES) {
        const g = frameGeometry(variant, w, h);
        const o = frameOverscan(w, h);
        expect(g).toMatchObject({ variant, width: w + 2 * o.x, height: h + 2 * o.y, left: -o.x, top: -o.y });
        expect(g.body.startsWith(`M${-o.x} ${-o.y}H${w + o.x}V${h + o.y}H${-o.x}Z`)).toBe(true);
        expect(g.panes.length).toBeGreaterThanOrEqual(variant === "vessel" ? 3 : 4);
        // Every number in every path is finite.
        for (const d of [g.body, ...g.panes, ...g.details.map((x) => x.d)]) expect(d).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  it("keeps posts about the same thickness in px on every screen", () => {
    expect(framePostPx(412, 915)).toBeGreaterThanOrEqual(10);
    expect(framePostPx(1400, 900)).toBeLessThanOrEqual(20);
    expect(framePostPx(3840, 2160)).toBe(20);
    expect(framePostPx(200, 300)).toBe(10);
  });

  it("is deterministic per size, and different sizes lay it out afresh", () => {
    expect(frameGeometry("vessel", 412, 915)).toEqual(frameGeometry("vessel", 412, 915));
    expect(frameGeometry("vessel", 915, 412).body).not.toBe(frameGeometry("vessel", 412, 915).body);
  });

  it("centres a bridge window straight ahead (no mullion in the middle of the view)", () => {
    const g = frameGeometry("vessel", 915, 412);
    const xs = (d: string) => [...d.matchAll(/[MLQ](-?[\d.]+) /g)].map((m) => Number(m[1]));
    const centred = g.panes.find((d) => Math.min(...xs(d)) < 915 / 2 && Math.max(...xs(d)) > 915 / 2);
    expect(centred).toBeDefined();
    const x = xs(centred as string);
    expect((Math.min(...x) + Math.max(...x)) / 2).toBeCloseTo(915 / 2, 0);
  });
});

describe("roundedPolygon", () => {
  it("rounds corners with a quadratic through the vertex, and leaves zero-radius points sharp", () => {
    const d = roundedPolygon([
      [0, 0, 10],
      [100, 0, 0],
      [100, 100, 10],
    ]);
    expect(d).toMatch(/^M.*Q.*L100 0L.*Q.*Z$/);
    expect(roundedPolygon([[0, 0, 1]])).toBe("");
  });

  it("never cuts a corner back by more than half an edge", () => {
    const d = roundedPolygon([
      [0, 0, 100],
      [10, 0, 100],
      [10, 10, 100],
      [0, 10, 100],
    ]);
    expect(d).toBe("M0 5Q0 0 5 0L5 0Q10 0 10 5L10 5Q10 10 5 10L5 10Q0 10 0 5Z");
  });
});
