/**
 * Typed fetch client for the skylens backend. Injects the bearer token from the
 * in-memory token store on every request and throws a typed ApiError on non-2xx.
 *
 * The base URL comes from expo-constants extra / env so demo (LAN backend) and
 * production (skylens.wsh.no) can differ without code changes.
 */

import { getAccessTokenSync } from "@/auth/tokenStore";
import type {
  AircraftDetail,
  AircraftDto,
  MeResponse,
  RouteResponse,
} from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
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
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = this.getToken();
    const headers = new Headers(init?.headers);
    headers.set("Accept", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = await res.text().catch(() => undefined);
      }
      throw new ApiError(res.status, `${init?.method ?? "GET"} ${path} → ${res.status}`, body);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  me(): Promise<MeResponse> {
    return this.request<MeResponse>("/api/me");
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

  /** Away-mode area query (ADSBx via the backend). */
  area(lat: number, lon: number, radiusKm: number): Promise<AircraftDto[]> {
    return this.request<AircraftDto[]>(`/api/area?lat=${lat}&lon=${lon}&radiusKm=${radiusKm}`);
  }
}
