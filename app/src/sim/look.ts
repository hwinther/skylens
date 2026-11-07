/**
 * Pure-TS look-around math for the cockpit view: the camera looks along the direction of travel plus a
 * look offset (yaw right-positive, pitch up-positive, degrees). The offset comes from dragging, or from
 * the phone's own pan/tilt (DeviceOrientation, as in the AR view) relative to the pose it had when that
 * mode was switched on or last recentred.
 *
 * Because the view can point anywhere, the HUD shows where "straight ahead" (the direction of travel)
 * is: a marker at its screen position while it's in view, clamped to the screen edge with an arrow
 * when it isn't, plus a recentre button. forwardMarker() decides where that marker goes.
 */

export interface Look {
  yaw: number;
  pitch: number;
}

/** Pitch offset limit, degrees, either way. */
export const MAX_LOOK_PITCH_DEG = 80;

/** Below this the view counts as centred (no recentre prompt). */
export const CENTRED_DEG = 3;

/** Wrap an angle to (-180, 180]. */
export function wrap180(deg: number): number {
  const d = ((((deg + 180) % 360) + 360) % 360) - 180;
  return d === -180 ? 180 : d;
}

function clampPitch(p: number): number {
  return Math.max(-MAX_LOOK_PITCH_DEG, Math.min(MAX_LOOK_PITCH_DEG, p));
}

/**
 * Look offset from the device pose (azimuth / elevation in degrees, as the AR sensors report them)
 * relative to the reference pose captured at enable / recentre: turn the phone 30° right → look 30°
 * right of the direction of travel.
 */
export function lookFromDevice(
  device: { azimuth: number; elevation: number },
  reference: { azimuth: number; elevation: number },
): Look {
  return {
    yaw: wrap180(device.azimuth - reference.azimuth),
    pitch: clampPitch(device.elevation - reference.elevation),
  };
}

/** True when the view is (close enough to) straight ahead. */
export function isCentred(look: Look): boolean {
  return Math.abs(wrap180(look.yaw)) < CENTRED_DEG && Math.abs(look.pitch) < CENTRED_DEG;
}

/** Short HUD text for the offset, e.g. "42° right · 10° up". Empty when centred. */
export function describeLook(look: Look): string {
  if (isCentred(look)) return "";
  const yaw = Math.round(wrap180(look.yaw));
  const pitch = Math.round(look.pitch);
  const parts: string[] = [];
  if (Math.abs(yaw) >= CENTRED_DEG) parts.push(`${Math.abs(yaw)}° ${yaw > 0 ? "right" : "left"}`);
  if (Math.abs(pitch) >= CENTRED_DEG) parts.push(`${Math.abs(pitch)}° ${pitch > 0 ? "up" : "down"}`);
  return parts.join(" · ");
}

export interface ForwardMarker {
  x: number;
  y: number;
  /** False when clamped to the edge: the marker then shows an arrow pointing `angleDeg`. */
  onScreen: boolean;
  /** Screen-space direction towards straight ahead, degrees clockwise from up. */
  angleDeg: number;
}

/**
 * Where to draw the "straight ahead" marker on a w×h view. `projected` is the direction of travel's
 * window position when the engine could project it in front of the camera (null when behind). Inside
 * the margin it's used as is; otherwise the marker sits on the edge, in the direction of the forward
 * vector — taken from the projection when there is one, else from the look offset (looking right means
 * forward is to the left; looking up means it is below).
 */
export function forwardMarker(
  look: Look,
  projected: { x: number; y: number } | null,
  w: number,
  h: number,
  margin = 28,
): ForwardMarker {
  const cx = w / 2;
  const cy = h / 2;
  if (
    projected &&
    projected.x >= margin &&
    projected.x <= w - margin &&
    projected.y >= margin &&
    projected.y <= h - margin
  ) {
    const dx = projected.x - cx;
    const dy = projected.y - cy;
    return { x: projected.x, y: projected.y, onScreen: true, angleDeg: angleOf(dx, dy) };
  }
  let dx: number;
  let dy: number;
  if (projected) {
    dx = projected.x - cx;
    dy = projected.y - cy;
  } else {
    dx = -wrap180(look.yaw);
    dy = look.pitch;
  }
  if (dx === 0 && dy === 0) dx = -1;
  // Scale the direction until it touches the inner rectangle.
  const hw = cx - margin;
  const hh = cy - margin;
  const k = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity);
  return { x: cx + dx * k, y: cy + dy * k, onScreen: false, angleDeg: angleOf(dx, dy) };
}

/** Screen angle, degrees clockwise from up (y grows downwards). */
function angleOf(dx: number, dy: number): number {
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}
