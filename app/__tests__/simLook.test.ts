/**
 * Cockpit look-around: device pan/tilt relative to the recentre pose, the offset text, and where the
 * "straight ahead" marker goes (projected when in view, clamped to the edge with an arrow when not).
 */

import { describeLook, forwardMarker, isCentred, lookFromDevice, MAX_LOOK_PITCH_DEG, wrap180 } from "@/sim/look";

test("wrap180 folds any angle into (-180, 180]", () => {
  expect(wrap180(0)).toBe(0);
  expect(wrap180(190)).toBe(-170);
  expect(wrap180(-190)).toBe(170);
  expect(wrap180(540)).toBe(180);
  expect(wrap180(-180)).toBe(180);
});

test("device look is relative to the recentre pose and wraps through north", () => {
  expect(lookFromDevice({ azimuth: 40, elevation: 5 }, { azimuth: 10, elevation: 0 })).toEqual({ yaw: 30, pitch: 5 });
  // Reference at 350°, phone turned to 20° → 30° right, not 330° left.
  expect(lookFromDevice({ azimuth: 20, elevation: 0 }, { azimuth: 350, elevation: 0 }).yaw).toBe(30);
  expect(lookFromDevice({ azimuth: 0, elevation: 120 }, { azimuth: 0, elevation: 0 }).pitch).toBe(MAX_LOOK_PITCH_DEG);
});

test("offset text names the way back", () => {
  expect(isCentred({ yaw: 1, pitch: -2 })).toBe(true);
  expect(describeLook({ yaw: 1, pitch: -2 })).toBe("");
  expect(describeLook({ yaw: 42, pitch: 0 })).toBe("42° right");
  expect(describeLook({ yaw: -90, pitch: 10.4 })).toBe("90° left · 10° up");
  expect(describeLook({ yaw: 350, pitch: 0 })).toBe("10° left");
});

test("in view: the marker sits on the projected direction of travel", () => {
  const m = forwardMarker({ yaw: 10, pitch: 0 }, { x: 300, y: 250 }, 800, 600);
  expect(m).toMatchObject({ x: 300, y: 250, onScreen: true });
});

test("out of view: clamped to the edge, pointing back towards straight ahead", () => {
  // Looking 120° right with the forward vector behind the camera: forward is to the left.
  const left = forwardMarker({ yaw: 120, pitch: 0 }, null, 800, 600);
  expect(left.onScreen).toBe(false);
  expect(left.x).toBe(28);
  expect(left.y).toBe(300);
  expect(left.angleDeg).toBe(270);
  // Looking up: forward is below.
  const below = forwardMarker({ yaw: 0, pitch: 60 }, null, 800, 600);
  expect(below.y).toBe(600 - 28);
  expect(below.angleDeg).toBe(180);
  // Projected but off the right edge → clamped on that edge.
  const right = forwardMarker({ yaw: -50, pitch: 0 }, { x: 1400, y: 300 }, 800, 600);
  expect(right).toMatchObject({ x: 800 - 28, y: 300, onScreen: false, angleDeg: 90 });
});
