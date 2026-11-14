/**
 * Cockpit view navigation aids, pure TS: the nearest airport (aircraft) or port (vessel) for the HUD,
 * and the great-circle route line to a known destination.
 *
 * Both use only what the app already has: the places come from the same /api/airports and /api/ports
 * fetches as the 3D labels (src/sim/overlay.ts), and a destination is only known when the followed
 * aircraft's route is already known under the gated policy — the detail card's free "cached route"
 * read on open, or the user's own tap on its "Route (uses AeroAPI)" button. Nothing here fetches.
 * The route gives an ICAO code; its coordinates come from the fetched nearby airports when it is
 * among them, else from one lookup in the offline airport database (GET /api/airports/{ident}, free,
 * see airportLookup.ts), so the line and the DEST row show from any distance.
 */

import type { AirportDto } from "@/api/types";
import { compass8 } from "@/components/webmap/relative";
import { bearingDeg, distanceKm, type OverlayPlace } from "./overlay";
import { FEET_TO_M } from "./simPose";

export interface GeoPos {
  lat: number;
  lon: number;
  altM: number;
}

/** Fewest segments in the drawn route line (a short hop). */
export const ROUTE_SEGMENTS = 64;
/**
 * Longest segment of a long route line, km. The polyline's segments are straight chords through the
 * globe, so a long one sags under the surface in its middle (about len² / 8R: ~12 m at 25 km, ~480 m at
 * 156 km, which 64 segments of an Oslo → New York line would be). Long lines get more points instead.
 */
export const ROUTE_MAX_SEGMENT_KM = 25;
/** Cap on the segments (a half-way-round-the-world line then has ~40 km segments). */
export const ROUTE_MAX_SEGMENTS = 512;

const EARTH_RADIUS_KM = 6371;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Segments for a route line this long: at least ROUTE_SEGMENTS, at most ROUTE_MAX_SEGMENT_KM each (capped). */
export function routeSegments(lengthKm: number): number {
  if (!Number.isFinite(lengthKm) || lengthKm <= 0) return ROUTE_SEGMENTS;
  return Math.min(ROUTE_MAX_SEGMENTS, Math.max(ROUTE_SEGMENTS, Math.ceil(lengthKm / ROUTE_MAX_SEGMENT_KM)));
}

/**
 * `segments + 1` points along the great circle from a to b (spherical slerp), with the altitude
 * blended linearly from a's to b's. Without `segments` the count follows the length (routeSegments).
 * Coincident or antipodal ends fall back to the two end points.
 */
export function greatCirclePoints(a: GeoPos, b: GeoPos, segments?: number): GeoPos[] {
  const vec = (p: GeoPos) => {
    const la = toRad(p.lat);
    const lo = toRad(p.lon);
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  };
  const va = vec(a);
  const vb = vec(b);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const omega = Math.acos(dot);
  const n = Math.max(1, Math.floor(segments ?? routeSegments(omega * EARTH_RADIUS_KM)));
  if (omega < 1e-9 || Math.PI - omega < 1e-9) return [{ ...a }, { ...b }];
  const sin = Math.sin(omega);
  const out: GeoPos[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const ka = Math.sin((1 - t) * omega) / sin;
    const kb = Math.sin(t * omega) / sin;
    const x = ka * va[0] + kb * vb[0];
    const y = ka * va[1] + kb * vb[1];
    const z = ka * va[2] + kb * vb[2];
    out.push({
      lat: toDeg(Math.atan2(z, Math.hypot(x, y))),
      lon: toDeg(Math.atan2(y, x)),
      altM: a.altM + (b.altM - a.altM) * t,
    });
  }
  return out;
}

/** The place with this code (airport ident, case-insensitive), or null. */
export function findPlaceByCode(places: readonly OverlayPlace[], code: string | null | undefined): OverlayPlace | null {
  const want = code?.trim().toUpperCase();
  if (!want) return null;
  return places.find((p) => p.code.toUpperCase() === want) ?? null;
}

/**
 * A route's airport code, normalised for the lookup endpoint: trimmed, upper case, and only when it is
 * a plausible ident (3-10 ASCII letters, digits or dashes, as the backend validates), else null.
 */
export function airportLookupCode(code: string | null | undefined): string | null {
  const c = code?.trim().toUpperCase();
  return c && /^[A-Z0-9-]{3,10}$/.test(c) ? c : null;
}

/** One airport from GET /api/airports/{ident} as a reference place (any class: it is a known destination). */
export function airportPlace(a: Pick<AirportDto, "ident" | "name" | "lat" | "lon" | "elevationFt">): OverlayPlace {
  return {
    kind: "airport",
    code: a.ident,
    name: a.name,
    lat: a.lat,
    lon: a.lon,
    altM: (a.elevationFt ?? 0) * FEET_TO_M,
  };
}

export interface NearestPlace {
  place: OverlayPlace;
  distanceKm: number;
  bearingDeg: number;
}

/** The nearest of `places` to a point, or null when there are none. */
export function nearestPlace(places: readonly OverlayPlace[], lat: number, lon: number): NearestPlace | null {
  let best: OverlayPlace | null = null;
  let bestD = Infinity;
  for (const p of places) {
    const d = distanceKm(lat, lon, p.lat, p.lon);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best ? { place: best, distanceKm: bestD, bearingDeg: bearingDeg(lat, lon, best.lat, best.lon) } : null;
}

/** "12 km" from 10 km up, "3.4 km" below. */
export function formatKm(km: number): string {
  return km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

/** Longest place name the HUD shows before truncating. */
const NAME_MAX = 18;

function shortName(p: OverlayPlace): string {
  const name = p.code || p.name;
  return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;
}

/** The HUD's nearest-place value, e.g. "ENGM 12 km NE" or "Aker Brygge 2.3 km SW". */
export function describeNearest(n: NearestPlace): string {
  return `${shortName(n.place)} ${formatKm(n.distanceKm)} ${compass8(n.bearingDeg)}`;
}

/** The HUD's destination value: "ESSA 312 km" when its position is known, else just "ESSA". */
export function describeDestination(code: string, from: { lat: number; lon: number }, dest: OverlayPlace | null): string {
  return dest ? `${code} ${formatKm(distanceKm(from.lat, from.lon, dest.lat, dest.lon))}` : code;
}
