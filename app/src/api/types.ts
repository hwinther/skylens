/**
 * API DTOs mirroring the backend slim contract. Keep these in lock-step with
 * backend/src/Api (the SnapshotBroadcaster slim DTO and the REST metadata/route
 * responses). Field names are intentionally terse to keep the SignalR payload small.
 */

/**
 * Slim aircraft DTO pushed over SignalR at 1 Hz and returned by
 * GET /api/aircraft. ~140 bytes/aircraft on the wire.
 */
export interface AircraftDto {
  /** ICAO 24-bit address, lowercase hex (e.g. "4ca7b3"). Stable id. */
  hex: string;
  /** Flight level (hundreds of feet) or null when unknown. */
  fl: number | null;
  /** Latitude in degrees, or null for position-less aircraft. */
  lat: number | null;
  /** Longitude in degrees, or null for position-less aircraft. */
  lon: number | null;
  /** Geometric/barometric altitude in feet, or null. */
  alt: number | null;
  /** Ground speed in knots, or null. */
  gs: number | null;
  /** Track (course over ground) in degrees, or null. */
  trk: number | null;
  /** Vertical rate in feet/minute, or null. */
  vr: number | null;
  /** Seconds since this aircraft was last seen. */
  seen: number;
  /** Emitter category (e.g. "A3"), or null. */
  cat: string | null;
  /** Data source tag: "adsb" (own feed), "adsbx", etc. */
  src: string;
  /** Callsign / flight number when present (trimmed). */
  flight?: string | null;
}

/** Response of GET /api/aircraft — a snapshot list plus a server timestamp. */
export interface AircraftSnapshot {
  /** Server epoch milliseconds the snapshot was assembled. */
  ts: number;
  aircraft: AircraftDto[];
}

/** Detail metadata for GET /api/aircraft/{hex}. Enriched from the offline DB / OpenSky. */
export interface AircraftDetail extends AircraftDto {
  /** Registration (tail number), when known. */
  registration: string | null;
  /** ICAO type designator (e.g. "B738"). */
  typeCode: string | null;
  /** Human type/model description. */
  typeName: string | null;
  /** Operator / airline name. */
  operator: string | null;
  /** Country of registration. */
  country: string | null;
}

/** A single leg on a flight route, from AeroAPI via GET /api/aircraft/{hex}/route. */
export interface RouteResponse {
  /** Callsign the route was resolved for. */
  callsign: string | null;
  /** IATA/ICAO origin airport code. */
  origin: string | null;
  /** IATA/ICAO destination airport code. */
  destination: string | null;
  /** Free-text origin name. */
  originName: string | null;
  /** Free-text destination name. */
  destinationName: string | null;
  /** ISO8601 estimated departure, when known. */
  departureTime: string | null;
  /** ISO8601 estimated arrival, when known. */
  arrivalTime: string | null;
}

/** GET /api/me — the authenticated user's identity as the backend sees it. */
export interface MeResponse {
  sub: string;
  preferredUsername: string | null;
  name: string | null;
  email: string | null;
  groups: string[];
}
