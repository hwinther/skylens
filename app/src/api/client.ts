/**
 * Typed fetch client for the skylens backend. Injects the bearer token from the
 * in-memory token store on every request and throws a typed ApiError on non-2xx.
 *
 * The base URL comes from expo-constants extra / env so demo (LAN backend) and
 * production (skylens.wsh.no) can differ without code changes.
 */

import { getAccessTokenSync } from "@/auth/tokenStore";
import { flushClientLog, reportClientFailure } from "./clientLog";
import type {
  AircraftDetail,
  AircraftDto,
  AirportsResponse,
  FishingZonesResponse,
  HealthResponse,
  LostGearResponse,
  MeResponse,
  RouteResponse,
  SatelliteDetail,
  SatelliteListResponse,
  VersionResponse,
  VesselDetail,
} from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
    /** True when the failure never reached the backend (no X-Skylens-Api marker) — killed at the edge. */
    public readonly edgeBlocked: boolean = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientConfig {
  /** Base URL, e.g. "https://skylens.wsh.no" or "http://10.20.13.100:8080". */
  baseUrl: string;
  /** Override the token source (defaults to the secure token store). */
  getToken?: () => string | null;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getToken: () => string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.getToken = config.getToken ?? getAccessTokenSync;
    // Bind to the global: browser fetch throws "Illegal invocation" if called with a `this` other
    // than the Window, which happens when we store and call it as this.fetchImpl(...). (RN's fetch
    // doesn't care, so this only bit on web.)
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = this.getToken();
    const headers = new Headers(init?.headers);
    headers.set("Accept", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);

    const method = init?.method ?? "GET";

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (err) {
      // No response at all (network drop / TLS reset — a dropped edge block looks like this too).
      reportClientFailure({ method, endpoint: path, status: null, edgeMarkerPresent: false, detail: String(err) });
      throw err;
    }

    // The X-Skylens-Api marker proves the response came from Kestrel; its absence on a failure means
    // an edge gateway (CrowdSec) killed the request before it reached us.
    const reachedBackend = res.headers.get("X-Skylens-Api") != null;

    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = await res.text().catch(() => undefined);
      }
      // Report incident-worthy failures (edge blocks + auth + server errors); skip routine 4xx like a
      // /route/cached 404 that callers expect and swallow, to keep the backend log signal high.
      if (!reachedBackend || res.status === 401 || res.status === 403 || res.status >= 500) {
        reportClientFailure({
          method,
          endpoint: path,
          status: res.status,
          edgeMarkerPresent: reachedBackend,
          detail: typeof body === "string" ? body.slice(0, 200) : undefined,
        });
      }
      throw new ApiError(res.status, `${method} ${path} → ${res.status}`, body, !reachedBackend);
    }

    // A success reached the backend → a good moment to flush any buffered failures (piggyback).
    void flushClientLog(this.baseUrl, this.fetchImpl);

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  me(): Promise<MeResponse> {
    return this.request<MeResponse>("/api/me");
  }

  /** GET /api/version — backend build info. Requires a valid bearer (401 when anonymous). */
  version(): Promise<VersionResponse> {
    return this.request<VersionResponse>("/api/version");
  }

  /** GET /healthz — anonymous health probe; its `version` field is the deployed backend build. */
  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/healthz");
  }

  /** List aircraft, optionally filtered to a radius around a point. */
  aircraft(params?: { lat: number; lon: number; radiusKm: number }): Promise<AircraftDto[]> {
    const qs = params
      ? `?lat=${params.lat}&lon=${params.lon}&radiusKm=${params.radiusKm}`
      : "";
    return this.request<AircraftDto[]>(`/api/aircraft${qs}`);
  }

  aircraftDetail(hex: string): Promise<AircraftDetail> {
    return this.request<AircraftDetail>(`/api/aircraft/${encodeURIComponent(hex)}`);
  }

  /** Explicit AeroAPI spend — only call this on a user tap of "Route". */
  aircraftRoute(hex: string): Promise<RouteResponse> {
    return this.request<RouteResponse>(`/api/aircraft/${encodeURIComponent(hex)}/route`);
  }

  /**
   * Cached-only route: the route if the backend already has it cached, else null. Never spends AeroAPI
   * budget, so it's safe to auto-load on detail open. Fail-silent (errors / 204 → null).
   */
  async aircraftRouteCached(hex: string): Promise<RouteResponse | null> {
    try {
      const route = await this.request<RouteResponse | null>(
        `/api/aircraft/${encodeURIComponent(hex)}/route/cached`,
      );
      return route ?? null;
    } catch {
      return null;
    }
  }

  /** GET /api/vessels/{mmsi} — live AIS state (if tracked) + BarentsWatch-enriched static metadata. */
  vesselDetail(mmsi: string): Promise<VesselDetail> {
    return this.request<VesselDetail>(`/api/vessels/${encodeURIComponent(mmsi)}`);
  }

  /** Away-mode area query (ADSBx via the backend). */
  area(lat: number, lon: number, radiusKm: number): Promise<AircraftDto[]> {
    return this.request<AircraftDto[]>(`/api/area?lat=${lat}&lon=${lon}&radiusKm=${radiusKm}`);
  }

  /**
   * GET /api/satellites — every satellite in the current CelesTrak TLE snapshot (orbital elements for
   * client-side SGP4) plus optional SatNOGS downlink summaries. 503 (ApiError) before the first snapshot.
   */
  satellites(): Promise<SatelliteListResponse> {
    return this.request<SatelliteListResponse>("/api/satellites");
  }

  /** GET /api/satellites/{noradId} — one satellite's elements + its full SatNOGS transmitter list. */
  satelliteDetail(noradId: number): Promise<SatelliteDetail> {
    return this.request<SatelliteDetail>(`/api/satellites/${noradId}`);
  }

  /**
   * GET /api/fishing/zones — cod-boundary + forbidden + zero fishing-regulation zones (GeoJSON). Returns
   * 200 with an empty `zones` array + a `note` when the backend's FiskInfo source is unconfigured.
   */
  fishingZones(): Promise<FishingZonesResponse> {
    return this.request<FishingZonesResponse>("/api/fishing/zones");
  }

  /**
   * GET /api/fishing/lostgear — reported lost/ghost fishing gear (anonymised points). Returns 200 with an
   * empty `gear` array + a `note` when the FiskInfo source is unconfigured.
   */
  lostGear(): Promise<LostGearResponse> {
    return this.request<LostGearResponse>("/api/fishing/lostgear");
  }

  /**
   * GET /api/airports — airports (with runways + TWR/ATIS frequencies) from the bundled offline
   * OurAirports dataset within `radiusKm` of the point, nearest-first (capped at 200). No upstream calls.
   */
  airports(lat: number, lon: number, radiusKm: number): Promise<AirportsResponse> {
    return this.request<AirportsResponse>(
      `/api/airports?lat=${lat}&lon=${lon}&radiusKm=${radiusKm}`,
    );
  }
}
