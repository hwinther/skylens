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

/** GET /api/aircraft/{hex}/route — AeroAPI route by callsign. */
export type RouteResponse = Schemas["Skylens.Api.Enrichment.FlightRoute"];

/** GET /api/me — the authenticated user's identity as the backend sees it. */
export type MeResponse = Schemas["Skylens.Api.Endpoints.ApiEndpoints.MeResponse"];

/**
 * GET /api/version — backend build info (requires bearer). Forward-declared by hand until the
 * backend ships the endpoint and openapi.json is regenerated; keep in sync with that contract:
 * `{ version, sha }`, where `sha` is the full 40-char commit sha (or empty when unavailable).
 */
export interface VersionResponse {
  version: string;
  sha: string;
}

/**
 * GET /healthz — anonymous health probe. Only the `version` field (added to the health payload
 * alongside the existing status) is consumed here, so the rest is left open. Forward-declared
 * for the same reason as VersionResponse.
 */
export interface HealthResponse {
  version?: string;
  [key: string]: unknown;
}
