/**
 * API DTOs — friendly names over the generated OpenAPI contract in ./generated/schema.ts. That file
 * is produced by `npm run openapi:generate` from backend/src/Api/openapi.json, which the backend emits
 * on every Debug build. Do NOT hand-edit field shapes here: change the backend DTO and regenerate
 * (CI fails on drift). We only (a) rename the verbose schema ids and (b) tighten `hex`, which the .NET
 * generator marks nullable (an NRT quirk) though it is always present.
 */

import type { components } from "./generated/schema";

type Schemas = components["schemas"];

/** Slim aircraft DTO (SignalR snapshot + GET /api/aircraft). `hex` is always present. */
export type AircraftDto = Omit<Schemas["Skylens.Api.State.AircraftDto"], "hex"> & { hex: string };

/** Enrichment metadata (offline DB / OpenSky). */
export type AircraftMetadata = Schemas["Skylens.Api.Enrichment.AircraftMetadata"];

/** GET /api/aircraft/{hex} — live state (if tracked) + resolved metadata; either half may be null. */
export type AircraftDetail = Schemas["Skylens.Api.Endpoints.ApiEndpoints.AircraftDetail"];

/** Slim vessel DTO (SignalR "vessels" message + GET /api/vessels). `mmsi`/`kind` are always present. */
export type VesselDto = Omit<
  Schemas["Skylens.Api.State.VesselDto"],
  "mmsi" | "kind"
> & { mmsi: string; kind: string };

/** Static vessel metadata (derived from AIS state; Phase 5 will enrich via BarentsWatch). */
export type VesselMetadata = Schemas["Skylens.Api.Enrichment.VesselMetadata"];

/** GET /api/vessels/{mmsi} — live state (if tracked) + derived metadata; either half may be null. */
export type VesselDetail = Schemas["Skylens.Api.Endpoints.ApiEndpoints.VesselDetail"];

/** GET /api/aircraft/{hex}/route — AeroAPI route by callsign. */
export type RouteResponse = Schemas["Skylens.Api.Enrichment.FlightRoute"];

/** GET /api/me — the authenticated user's identity as the backend sees it. */
export type MeResponse = Schemas["Skylens.Api.Endpoints.ApiEndpoints.MeResponse"];

/**
 * GET /api/version — backend build info (requires bearer). `version` and `sha` are tightened like
 * `hex` above: the backend record declares non-nullable strings (`sha` is the full 40-char commit
 * sha, or "" when unavailable), but the generator's NRT quirk marks them nullable.
 */
export type VersionResponse = Omit<
  Schemas["Skylens.Api.Endpoints.ApiEndpoints.VersionResponse"],
  "version" | "sha"
> & { version: string; sha: string };

/**
 * GET /healthz — anonymous health probe. `version` (the deployed backend build) is tightened for
 * the same NRT-quirk reason: the backend record declares it as a non-nullable string.
 */
export type HealthResponse = Omit<
  Schemas["Skylens.Api.Endpoints.HealthEndpoints.HealthResponse"],
  "version"
> & { version: string };

/**
 * The verbatim CelesTrak OMM (Orbit Mean-Elements Message) element set — UPPERCASE keys BY DESIGN, so
 * it feeds straight into satellite.js `json2satrec` to build the SGP4 propagator. Aliased directly (the
 * numeric SGP4 inputs are already non-nullable in the generated schema).
 */
export type SatelliteOmm = Schemas["Skylens.Api.Enrichment.OmmElements"];

/** One SatNOGS transmitter for a satellite (frequencies in Hz; `alive` + `status` mark active downlinks). */
export type SatelliteTransmitter = Schemas["Skylens.Api.Enrichment.SatelliteTransmitterDto"];

/**
 * A satellite in view (GET /api/satellites list item + detail): identity, group, an optional SatNOGS
 * downlink summary, and the raw OMM elements. `noradId`/`name`/`group`/`omm` are always present —
 * tightened like the vessel DTO's identity fields (the .NET generator marks them optional, an NRT quirk).
 */
export type SatelliteDto = Omit<
  Schemas["Skylens.Api.Enrichment.SatelliteDto"],
  "noradId" | "name" | "group" | "omm"
> & { noradId: number; name: string; group: string; omm: SatelliteOmm };

/** GET /api/satellites — snapshot fetch time + age + every satellite currently in the TLE snapshot. */
export type SatelliteListResponse = Omit<
  Schemas["Skylens.Api.Endpoints.ApiEndpoints.SatelliteListResponse"],
  "fetchedAtUtc" | "tleAgeSeconds" | "satellites"
> & { fetchedAtUtc: string; tleAgeSeconds: number; satellites: SatelliteDto[] };

/** GET /api/satellites/{noradId} — one satellite + its full transmitter list (possibly empty). */
export type SatelliteDetail = Omit<
  Schemas["Skylens.Api.Endpoints.ApiEndpoints.SatelliteDetail"],
  "satellite" | "transmitters"
> & { satellite: SatelliteDto; transmitters: SatelliteTransmitter[] };
