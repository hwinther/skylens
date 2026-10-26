import {
  DEFAULT_HFOV_DEG,
  DEFAULT_PROJECTION_CONFIG,
  effectiveHFovDeg,
  project,
  type ProjectionConfig,
} from "@/ar/projection";
import type { CameraPose } from "@/ar/orientation";

const NORTH_LEVEL: CameraPose = { azimuth: 0, elevation: 0, roll: 0 };
const CONFIG: ProjectionConfig = { ...DEFAULT_PROJECTION_CONFIG };

describe("project — centered / upper-half cases", () => {
  it("aircraft due north at 45° el lands centered horizontally, upper half, when camera faces north level", () => {
    const p = project({ azimuth: 0, elevation: 45 }, NORTH_LEVEL, CONFIG);
    expect(p.onScreen).toBe(true);
    expect(p.xNdc).toBeCloseTo(0, 6); // dead center horizontally
    expect(p.yNdc).toBeGreaterThan(0); // upper half (up is +y)
    expect(p.behind).toBe(false);
    expect(p.arrowBearingDeg).toBeNull();
  });

  it("target on the bore-sight projects to the exact center", () => {
    const p = project({ azimuth: 0, elevation: 0 }, NORTH_LEVEL, CONFIG);
    expect(p.xNdc).toBeCloseTo(0, 9);
    expect(p.yNdc).toBeCloseTo(0, 9);
    expect(p.onScreen).toBe(true);
  });

  it("a target at exactly half the hFOV to the right sits at xNdc≈1", () => {
    const p = project({ azimuth: DEFAULT_HFOV_DEG / 2, elevation: 0 }, NORTH_LEVEL, CONFIG);
    expect(p.xNdc).toBeCloseTo(1, 6);
    expect(p.onScreen).toBe(true); // right at the edge, still within margin
  });

  it("a target left of bore has negative x", () => {
    const p = project({ azimuth: 350, elevation: 0 }, NORTH_LEVEL, CONFIG);
    expect(p.xNdc).toBeLessThan(0);
  });
});

describe("project — culling and off-screen arrows", () => {
  it("a target well outside the FOV to the right is off-screen with a rightward arrow", () => {
    const p = project({ azimuth: 60, elevation: 0 }, NORTH_LEVEL, CONFIG);
    expect(p.onScreen).toBe(false);
    expect(p.behind).toBe(false);
    expect(p.arrowBearingDeg).not.toBeNull();
    // Rightward on screen ≈ bearing 90°.
    expect(p.arrowBearingDeg).toBeGreaterThan(45);
    expect(p.arrowBearingDeg).toBeLessThan(135);
  });

  it("a target high above the FOV is off-screen with an upward arrow", () => {
    const p = project({ azimuth: 0, elevation: 80 }, NORTH_LEVEL, CONFIG);
    expect(p.onScreen).toBe(false);
    // Upward ≈ bearing 0° (or ~360).
    const bearing = p.arrowBearingDeg as number;
    const nearUp = bearing < 45 || bearing > 315;
    expect(nearUp).toBe(true);
  });

  it("a target directly behind the camera is classified as behind", () => {
    const p = project({ azimuth: 180, elevation: 0 }, NORTH_LEVEL, CONFIG);
    expect(p.behind).toBe(true);
    expect(p.onScreen).toBe(false);
  });
});

describe("effectiveHFovDeg — focal length constant across rotation", () => {
  it("portrait (aspect ≤ 1) returns the base FOV unchanged", () => {
    expect(effectiveHFovDeg(66, 9 / 16)).toBeCloseTo(66, 9);
    expect(effectiveHFovDeg(66, 1)).toBeCloseTo(66, 9);
  });

  it("landscape widens the horizontal FOV beyond the base", () => {
    expect(effectiveHFovDeg(66, 16 / 9)).toBeGreaterThan(66);
  });

  it("keeps the short screen edge subtending the base FOV after a 90° turn", () => {
    // Portrait short edge = width = base. Landscape short edge = height, whose FOV project()
    // derives from the widened horizontal FOV and the aspect — it must come back to the base.
    const base = 66;
    const aspect = 16 / 9;
    const effH = effectiveHFovDeg(base, aspect);
    const derivedVFov =
      (2 * Math.atan(Math.tan((effH * Math.PI) / 180 / 2) / aspect) * 180) / Math.PI;
    expect(derivedVFov).toBeCloseTo(base, 6);
  });

  it("preserves a target's position relative to the short screen edge across rotation", () => {
    const base = 66;
    const aspect = 16 / 9;
    const portrait = project({ azimuth: 20, elevation: 0 }, NORTH_LEVEL, {
      hFovDeg: base,
      aspect: 9 / 16,
      cullMargin: 0.15,
    });
    const landscape = project({ azimuth: 20, elevation: 0 }, NORTH_LEVEL, {
      hFovDeg: effectiveHFovDeg(base, aspect),
      aspect,
      cullMargin: 0.15,
    });
    // Short edge = width (portrait) vs height (landscape); expressing the horizontal offset in
    // short-edge units (×aspect for landscape) must match — the focal length didn't change.
    expect(landscape.xNdc * aspect).toBeCloseTo(portrait.xNdc, 9);
  });
});

describe("project — roll rotation", () => {
  it("rolling the camera moves an above-bore target sideways", () => {
    const straight = project({ azimuth: 0, elevation: 20 }, NORTH_LEVEL, CONFIG);
    const rolled = project(
      { azimuth: 0, elevation: 20 },
      { azimuth: 0, elevation: 0, roll: 90 },
      CONFIG,
    );
    // A point straight above bore should move toward one horizontal side under a 90° roll.
    expect(Math.abs(straight.xNdc)).toBeLessThan(0.01);
    expect(Math.abs(rolled.xNdc)).toBeGreaterThan(Math.abs(rolled.yNdc));
  });

  it("roll preserves radial distance from center", () => {
    const straight = project({ azimuth: 5, elevation: 10 }, NORTH_LEVEL, CONFIG);
    const rolled = project(
      { azimuth: 5, elevation: 10 },
      { azimuth: 0, elevation: 0, roll: 37 },
      CONFIG,
    );
    const rStraight = Math.hypot(straight.xNdc, straight.yNdc);
    const rRolled = Math.hypot(rolled.xNdc, rolled.yNdc);
    expect(rRolled).toBeCloseTo(rStraight, 6);
  });
});
