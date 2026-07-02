import {
  applyDeclinationAndTrim,
  cameraPoseFromRotation,
  poseFromMatrix,
  rotationMatrixFromEuler,
  type CameraPose,
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
});
