/**
 * Pure-TypeScript geodetic → local ENU (East, North, Up) math for the AR overlay.
 *
 * The overlay treats aircraft as points on an equirectangular tangent plane at the
 * observer: dN/dE are metres from a small-angle projection, dU accounts for the
 * aircraft altitude minus the observer's height, minus the geometric drop caused by
 * earth curvature over the ground distance. From ENU we derive azimuth (compass
 * bearing, 0 = North, clockwise), elevation angle, and slant range.
 *
 * IMPORTANT: this file must import nothing from react-native / expo / react so that
 * jest can exercise it on any platform (see eslint no-restricted-imports guard).
 */

/** Metres per degree of latitude (mean, WGS-84 close enough for a local overlay). */
export const METERS_PER_DEG = 111_320;

/** Mean earth radius in metres, used for the curvature drop. */
export const EARTH_RADIUS_M = 6_371_000;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export function deg2rad(d: number): number {
  return d * DEG2RAD;
}

export function rad2deg(r: number): number {
  return r * RAD2DEG;
}

export interface GeoPoint {
  /** Latitude in degrees. */
  lat: number;
  /** Longitude in degrees. */
  lon: number;
  /** Altitude / height above mean sea level in metres. */
  alt: number;
}

export interface Enu {
  /** Metres east of the observer. */
  e: number;
  /** Metres north of the observer. */
  n: number;
  /** Metres up from the observer (curvature-corrected). */
  u: number;
}

export interface LookAngles {
  /** Azimuth in degrees, 0 = North, increasing clockwise, range [0, 360). */
  azimuth: number;
  /** Elevation in degrees above the local horizontal, range [-90, 90]. */
  elevation: number;
  /** Straight-line (slant) distance to the target in metres. */
  slantRange: number;
  /** Horizontal ground distance in metres. */
  groundDistance: number;
}

/**
 * Convert a target geodetic point to local ENU metres relative to an observer,
 * using the equirectangular small-angle approximation and subtracting the
 * earth-curvature drop from the up component.
 *
 * dN = Δlat · METERS_PER_DEG
 * dE = Δlon · METERS_PER_DEG · cos(observerLat)
 * dU = (alt_target − alt_observer) − groundDistance² / (2·R)
 */
export function geodeticToEnu(observer: GeoPoint, target: GeoPoint): Enu {
  const dLat = target.lat - observer.lat;
  const dLon = target.lon - observer.lon;
  const n = dLat * METERS_PER_DEG;
  const e = dLon * METERS_PER_DEG * Math.cos(deg2rad(observer.lat));
  const groundDistance = Math.hypot(e, n);
  const curvatureDrop = (groundDistance * groundDistance) / (2 * EARTH_RADIUS_M);
  const u = target.alt - observer.alt - curvatureDrop;
  return { e, n, u };
}

/** Normalise an azimuth in degrees to the [0, 360) range. */
export function normalizeAzimuth(azDeg: number): number {
  let a = azDeg % 360;
  if (a < 0) a += 360;
  return a;
}

/**
 * Signed shortest angular difference a − b in degrees, wrapped to (−180, 180].
 * Positive means `a` is clockwise (to the right) of `b`.
 */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Compute azimuth / elevation / slant range from an ENU vector. */
export function enuToLookAngles(enu: Enu): LookAngles {
  const groundDistance = Math.hypot(enu.e, enu.n);
  const azimuth = normalizeAzimuth(rad2deg(Math.atan2(enu.e, enu.n)));
  const elevation = rad2deg(Math.atan2(enu.u, groundDistance));
  const slantRange = Math.hypot(groundDistance, enu.u);
  return { azimuth, elevation, slantRange, groundDistance };
}

/** Convenience: observer + target geodetic points → look angles. */
export function lookAngles(observer: GeoPoint, target: GeoPoint): LookAngles {
  return enuToLookAngles(geodeticToEnu(observer, target));
}
