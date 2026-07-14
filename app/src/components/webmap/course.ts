/**
 * Predicted-track ("velocity leader") geometry for moving traffic on the map + radar. A leader starts
 * at the target's current position and ends where it would be after a fixed lead time at its current
 * speed & heading — the standard ADS-B / marine-ARPA course vector. The physical lead distance is the
 * single source of truth: `leadDistanceKm` is computed once, then the geographic maps project it via a
 * great-circle destination while the radar projects the same km to pixels — so a target's leader spans
 * the same real distance on every surface. AtoNs (stationary aids) and targets with no/too-slow speed
 * or missing heading get no leader (null).
 */

import type { AircraftDto, VesselDto } from "@/api/types";
import type { LatLngTuple } from "./geojson";
import { course } from "@/theme";

/** Lead time for aircraft (2 min) — short, because they cover a lot of ground fast. */
export const AIRCRAFT_LEAD_SECONDS = 120;
/** Lead time for ships (15 min) — long, so a slow vessel's leader is still visible at map scale. */
export const SHIP_LEAD_SECONDS = 900;
/** Below this speed (knots) a target is treated as stationary — no leader drawn. */
export const MIN_COURSE_SPEED_KN = 1;

/** Aircraft leader colour (blue — matches aircraft everywhere). */
export const AIRCRAFT_COURSE_COLOR = course.aircraft;
/** Vessel leader colour (teal — matches vessels everywhere). */
export const SHIP_COURSE_COLOR = course.ship;

/** Distance a target covers in `leadSeconds` at `speedKn`, in km (1 knot = 1.852 km/h). */
export function leadDistanceKm(speedKn: number, leadSeconds: number): number {
  return speedKn * 1.852 * (leadSeconds / 3600);
}

/**
 * Great-circle forward: the point `distanceKm` from (lat, lon) along `bearingDeg` (spherical law of
 * cosines / haversine destination, Earth radius 6371.0088 km). Longitude is normalized to [-180, 180].
 */
export function destinationPoint(
  lat: number,
  lon: number,
  bearingDeg: number,
  distanceKm: number,
): LatLngTuple {
  const R = 6371.0088;
  const delta = distanceKm / R; // angular distance
  const theta = (bearingDeg * Math.PI) / 180;
  const phi1 = (lat * Math.PI) / 180;
  const lambda1 = (lon * Math.PI) / 180;
  const sinPhi2 = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(sinPhi2);
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * sinPhi2,
    );
  return [(phi2 * 180) / Math.PI, (((lambda2 * 180) / Math.PI + 540) % 360) - 180];
}

/**
 * A two-point leader ([start, end]) for a target at (lat, lon), or null when it can't/shouldn't have
 * one: no speed, speed below MIN_COURSE_SPEED_KN, or a missing bearing.
 */
export function courseVector(
  lat: number,
  lon: number,
  bearingDeg: number | null | undefined,
  speedKn: number | null | undefined,
  leadSeconds: number,
): LatLngTuple[] | null {
  if (speedKn == null || speedKn < MIN_COURSE_SPEED_KN || bearingDeg == null) return null;
  return [
    [lat, lon],
    destinationPoint(lat, lon, bearingDeg, leadDistanceKm(speedKn, leadSeconds)),
  ];
}

/** Leader for an aircraft: track (deg) + ground speed (kn), 2 min ahead. Null when unpositioned. */
export function aircraftCourseVector(a: AircraftDto): LatLngTuple[] | null {
  if (a.lat == null || a.lon == null) return null;
  return courseVector(a.lat, a.lon, a.trk, a.gs, AIRCRAFT_LEAD_SECONDS);
}

/** Leader for a ship: course-over-ground (heading fallback) + speed, 15 min ahead. AtoNs get none. */
export function vesselCourseVector(v: VesselDto): LatLngTuple[] | null {
  if (v.kind !== "ship" || v.lat == null || v.lon == null) return null;
  return courseVector(v.lat, v.lon, v.cog ?? v.hdg, v.sog, SHIP_LEAD_SECONDS);
}
