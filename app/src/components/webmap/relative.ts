/**
 * Observer-relative geometry for the Map (radar) and List views: how far and in which direction each
 * aircraft is from the viewer. Reuses the AR math (local ENU tangent plane) so it stays consistent
 * with the overlay.
 */

import { geodeticToEnu, normalizeAzimuth, rad2deg } from "@/ar";

/** Observer position — home coords carry no altitude. */
export interface Observer {
  lat: number;
  lon: number;
}

export interface RelativePosition {
  /** Ground distance in km. */
  distanceKm: number;
  /** Bearing from the observer, degrees true (0 = N, 90 = E). */
  bearingDeg: number;
}

export function relativePosition(observer: Observer, lat: number, lon: number): RelativePosition {
  const enu = geodeticToEnu({ lat: observer.lat, lon: observer.lon, alt: 0 }, { lat, lon, alt: 0 });
  return {
    distanceKm: Math.hypot(enu.e, enu.n) / 1000,
    bearingDeg: normalizeAzimuth(rad2deg(Math.atan2(enu.e, enu.n))),
  };
}

const COMPASS_8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** Nearest 8-point compass label for a bearing. */
export function compass8(bearingDeg: number): string {
  return COMPASS_8[Math.round(normalizeAzimuth(bearingDeg) / 45) % 8];
}
