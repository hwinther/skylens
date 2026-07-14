/**
 * Hand-checkable unit tests for the web DeviceOrientation → CameraPose math.
 *
 * Frame recap (see webOrientation.ts / orientation.ts): world is ENU (x East, y North,
 * z Up); R = Rz(alpha)·Rx(beta)·Ry(gamma) with columns = device x/y/z in world; the back
 * camera bore is R·[0,0,−1]; azimuth = atan2(East, North) (0 = N, 90 = E, CW).
 *
 * Physical anchors used below:
 *  - beta = 90 stands the phone upright in portrait (top edge to the sky), so the back
 *    camera looks out at the horizon (elevation 0). Its azimuth is then normalize(−alpha):
 *    device alpha increases counter-clockwise while a compass azimuth increases clockwise,
 *    so a bigger alpha yields a smaller azimuth (they are mirror images).
 *  - beta = 0 lays the phone flat, screen up, so the back camera points at the ground
 *    (elevation −90).
 */

import { poseFromOrientation, type WebOrientationSample } from "@/ar/webOrientation";

/** Build a sample with sane defaults (absolute Android event, portrait screen). */
function sample(over: Partial<WebOrientationSample>): WebOrientationSample {
  return { alpha: 0, beta: 0, gamma: 0, absolute: true, screenAngle: 0, ...over };
}

describe("poseFromOrientation — basic pointing", () => {
  it("upright portrait facing north (alpha 0, beta 90) → az 0, el 0", () => {
    const pose = poseFromOrientation(sample({ alpha: 0, beta: 90 }))!;
    expect(pose).not.toBeNull();
    expect(pose.azimuth).toBeCloseTo(0, 4);
    expect(pose.elevation).toBeCloseTo(0, 4);
    // Upright portrait → the image is level, so roll is 0.
    expect(pose.roll).toBeCloseTo(0, 4);
  });

  it("flat on the table, screen up (beta 0) → el −90 (camera looks down)", () => {
    const pose = poseFromOrientation(sample({ alpha: 0, beta: 0 }))!;
    expect(pose.elevation).toBeCloseTo(-90, 4);
  });

  it("beta 120 (tilt the top back 30° past upright) → el +30, az still 0", () => {
    // Past 90° the bore rises above the horizon by (beta − 90): 120 → +30.
    const pose = poseFromOrientation(sample({ alpha: 0, beta: 120 }))!;
    expect(pose.elevation).toBeCloseTo(30, 4);
    expect(pose.azimuth).toBeCloseTo(0, 4);
  });
});

describe("poseFromOrientation — four cardinals are 90° apart, azimuth decreasing in alpha", () => {
  // Upright (beta 90). Expected azimuth = normalize(−alpha):
  //   alpha 0   → 0   (North)
  //   alpha 90  → 270 (West)   — turning the device CCW swings the compass CW-negative
  //   alpha 180 → 180 (South)
  //   alpha 270 → 90  (East)
  const cases: { alpha: number; az: number; name: string }[] = [
    { alpha: 0, az: 0, name: "N" },
    { alpha: 90, az: 270, name: "W" },
    { alpha: 180, az: 180, name: "S" },
    { alpha: 270, az: 90, name: "E" },
  ];

  for (const c of cases) {
    it(`alpha ${c.alpha} → az ${c.az} (${c.name}), level`, () => {
      const pose = poseFromOrientation(sample({ alpha: c.alpha, beta: 90 }))!;
      expect(pose.azimuth).toBeCloseTo(c.az, 4);
      expect(pose.elevation).toBeCloseTo(0, 4);
    });
  }

  it("each 90° of alpha steps the azimuth by exactly 90° (opposite sign)", () => {
    const az = (alpha: number) => poseFromOrientation(sample({ alpha, beta: 90 }))!.azimuth;
    // az(0)=0, az(90)=270 → a +90 alpha step is a −90 azimuth step (mod 360).
    const step = ((az(0) - az(90) + 540) % 360) - 180;
    expect(step).toBeCloseTo(90, 4);
  });
});

describe("poseFromOrientation — screen rotation compensation", () => {
  it("landscape (screenAngle 90) with the camera north & level → same az/el as upright portrait", () => {
    // Rolling the upright-north phone into landscape so its top edge points along the
    // horizon: the raw euler angles become alpha 90, beta 0, gamma −90 (a gimbal-edge
    // landscape pose), and the screen reports angle 90. The bore is unchanged, so az/el
    // must match the portrait north case (az 0, el 0); only roll differs.
    const portrait = poseFromOrientation(sample({ alpha: 0, beta: 90 }))!;
    const landscape = poseFromOrientation(
      sample({ alpha: 90, beta: 0, gamma: -90, screenAngle: 90 }),
    )!;
    expect(landscape.azimuth).toBeCloseTo(portrait.azimuth, 4);
    expect(landscape.elevation).toBeCloseTo(portrait.elevation, 4);
    expect(landscape.azimuth).toBeCloseTo(0, 4);
    expect(landscape.elevation).toBeCloseTo(0, 4);
  });
});

describe("poseFromOrientation — iOS webkitCompassHeading correction", () => {
  it("arbitrary alpha but a real compass heading → azimuth locks to the heading", () => {
    // Upright (beta 90): the device top and the camera bore share the same horizontal
    // azimuth, so the correction offset makes the corrected azimuth equal the heading
    // exactly. alpha 123 is an arbitrary iOS origin; the compass says 45 → az 45.
    const pose = poseFromOrientation(
      sample({ alpha: 123, beta: 90, gamma: 0, absolute: false, webkitCompassHeading: 45 }),
    )!;
    expect(pose.azimuth).toBeCloseTo(45, 4);
    expect(pose.elevation).toBeCloseTo(0, 4);
  });

  it("without absolute+heading the raw (arbitrary-origin) azimuth is left untouched", () => {
    // Same geometry, no compass heading → no correction, so it stays at normalize(−123) = 237.
    const pose = poseFromOrientation(sample({ alpha: 123, beta: 90, absolute: false }))!;
    expect(pose.azimuth).toBeCloseTo(237, 4);
  });
});

describe("poseFromOrientation — missing angles", () => {
  it("null alpha → null", () => {
    const pose = poseFromOrientation({
      alpha: null,
      beta: 0,
      gamma: 0,
      absolute: true,
      screenAngle: 0,
    } as unknown as WebOrientationSample);
    expect(pose).toBeNull();
  });

  it("NaN beta → null", () => {
    expect(poseFromOrientation(sample({ beta: NaN }))).toBeNull();
  });
});
