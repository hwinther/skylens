import {
  applyDeclinationAndTrim,
  cameraPoseFromRotation,
  poseFromMatrix,
  rotationMatrixFromEuler,
  type CameraPose,
  type Mat3,
} from "@/ar/orientation";

const D2R = Math.PI / 180;

describe("rotationMatrixFromEuler + poseFromMatrix", () => {
  it("phone flat, screen up (all zero) → back camera looks straight down", () => {
    const r = rotationMatrixFromEuler({ alpha: 0, beta: 0, gamma: 0 });
    const pose = poseFromMatrix(r);
    // Back camera is device −Z; flat screen-up means −Z points to world −Up → el −90.
    expect(pose.elevation).toBeCloseTo(-90, 4);
  });

  it("phone tilted up 90° (beta = +90) → back camera looks at the horizon", () => {
    // Standing the phone up on its bottom edge: beta = +90°. The back camera then
    // looks out horizontally. Elevation should be ~0.
    const r = rotationMatrixFromEuler({ alpha: 0, beta: 90 * D2R, gamma: 0 });
    const pose = poseFromMatrix(r);
    expect(pose.elevation).toBeCloseTo(0, 3);
  });

  it("yaw (alpha) rotates the camera azimuth", () => {
    // At beta=90 (looking at horizon), alpha rotates which way we face. Two
    // different alphas must give two different azimuths ~alpha apart.
    const a0 = poseFromMatrix(rotationMatrixFromEuler({ alpha: 0, beta: 90 * D2R, gamma: 0 }));
    const a90 = poseFromMatrix(
      rotationMatrixFromEuler({ alpha: 90 * D2R, beta: 90 * D2R, gamma: 0 }),
    );
    const delta = Math.abs(((a90.azimuth - a0.azimuth + 540) % 360) - 180);
    expect(delta).toBeCloseTo(90, 1);
  });

  it("elevation is bounded in [-90, 90] and azimuth in [0, 360)", () => {
    for (let a = 0; a < 360; a += 45) {
      for (let b = -90; b <= 90; b += 45) {
        const pose = poseFromMatrix(
          rotationMatrixFromEuler({ alpha: a * D2R, beta: b * D2R, gamma: 0 }),
        );
        expect(pose.elevation).toBeGreaterThanOrEqual(-90.001);
        expect(pose.elevation).toBeLessThanOrEqual(90.001);
        expect(pose.azimuth).toBeGreaterThanOrEqual(0);
        expect(pose.azimuth).toBeLessThan(360);
      }
    }
  });
});

describe("poseFromMatrix — screen-orientation roll compensation", () => {
  // Device turned 90° clockwise into landscape (top edge to the right), back camera looking
  // north at the horizon. Columns of R = device x/y/z expressed in world ENU:
  //   device +X (right) → world −Up (down), +Y (top) → world East, +Z (out) → world South.
  const landscapeR: Mat3 = [
    [0, 1, 0],
    [0, 0, -1],
    [-1, 0, 0],
  ];

  it("keeps azimuth/elevation invariant to the screen angle (only roll changes)", () => {
    const a = poseFromMatrix(landscapeR, 0);
    const b = poseFromMatrix(landscapeR, -90);
    expect(a.azimuth).toBeCloseTo(0, 4);
    expect(a.elevation).toBeCloseTo(0, 4);
    expect(b.azimuth).toBeCloseTo(a.azimuth, 4);
    expect(b.elevation).toBeCloseTo(a.elevation, 4);
  });

  it("without compensation a landscape hold reports a ~90° roll", () => {
    // Screen angle 0 = the old behaviour: roll is measured off the raw device top, so a
    // sideways phone looks rolled 90° and labels would rotate off level.
    const pose = poseFromMatrix(landscapeR, 0);
    expect(Math.abs(pose.roll)).toBeCloseTo(90, 4);
  });

  it("negated expo orientation (−90 for RightLandscape) makes the landscape hold read level", () => {
    // expo DeviceMotion.orientation = 90 for this hold; usePoseRefs passes its negation.
    const pose = poseFromMatrix(landscapeR, -90);
    expect(pose.roll).toBeCloseTo(0, 4);
  });

  it("screenAngleDeg default of 0 is identical to the raw device-top reference", () => {
    const r = rotationMatrixFromEuler({ alpha: 0.3, beta: 1.1, gamma: -0.4 });
    expect(poseFromMatrix(r).roll).toBeCloseTo(poseFromMatrix(r, 0).roll, 12);
  });
});

describe("applyDeclinationAndTrim", () => {
  const base: CameraPose = { azimuth: 10, elevation: 5, roll: 0 };

  it("adds declination to convert magnetic → true north", () => {
    const out = applyDeclinationAndTrim(base, 3, 0); // +3° east declination
    expect(out.azimuth).toBeCloseTo(13, 6);
  });

  it("adds manual trim on top of declination", () => {
    const out = applyDeclinationAndTrim(base, 3, -5);
    expect(out.azimuth).toBeCloseTo(8, 6);
  });

  it("wraps below zero correctly", () => {
    const out = applyDeclinationAndTrim({ ...base, azimuth: 2 }, 0, -5);
    expect(out.azimuth).toBeCloseTo(357, 6);
  });

  it("leaves elevation and roll untouched", () => {
    const out = applyDeclinationAndTrim(base, 3, -5);
    expect(out.elevation).toBe(5);
    expect(out.roll).toBe(0);
  });
});

describe("cameraPoseFromRotation full pipeline", () => {
  it("applies declination to the derived azimuth", () => {
    const withDecl = cameraPoseFromRotation({ alpha: 0, beta: 90 * D2R, gamma: 0 }, 10, 0);
    const without = cameraPoseFromRotation({ alpha: 0, beta: 90 * D2R, gamma: 0 }, 0, 0);
    const delta = ((withDecl.azimuth - without.azimuth + 540) % 360) - 180;
    expect(delta).toBeCloseTo(10, 4);
  });

  it("threads the screen angle through to the roll", () => {
    const rot = { alpha: 0, beta: 90 * D2R, gamma: 0 }; // upright portrait, north, level
    const portrait = cameraPoseFromRotation(rot, 0, 0, 0);
    const landscape = cameraPoseFromRotation(rot, 0, 0, 90);
    expect(portrait.roll).toBeCloseTo(0, 4);
    // Same device pose, a +90 reported screen angle → the roll reference swings by 90°.
    const delta = ((landscape.roll - portrait.roll + 540) % 360) - 180;
    expect(Math.abs(delta)).toBeCloseTo(90, 4);
    // Bore is unaffected by the screen angle.
    expect(landscape.azimuth).toBeCloseTo(portrait.azimuth, 4);
    expect(landscape.elevation).toBeCloseTo(portrait.elevation, 4);
  });
});
