/**
 * SignalR connection factory for the /hubs/aircraft hub.
 *
 * We force the WebSockets transport (React Native has no EventSource/long-poll story
 * worth relying on, and WS is what the backend expects), pull the bearer token via
 * accessTokenFactory from the in-memory token store (so reconnects always use a
 * fresh token), and enable automatic reconnect with a bounded backoff schedule.
 *
 * The hub contract:
 *  - server → client "snapshot" (AircraftDto[]) at 1 Hz
 *  - client → server "Subscribe"(lat, lon, radiusKm), throttled ~1/10 s
 */

import {
  HttpTransportType,
  HubConnection,
  HubConnectionBuilder,
  LogLevel,
} from "@microsoft/signalr";
import { getAccessTokenSync } from "@/auth/tokenStore";
import type { AircraftDto } from "./types";

export interface HubFactoryConfig {
  /** Base URL of the backend, e.g. "https://skylens.wsh.no". */
  baseUrl: string;
  /** Token source override (defaults to the secure token store). */
  getToken?: () => string | null;
  /** Log level; quiet by default. */
  logLevel?: LogLevel;
}

/** Backoff schedule (ms) for withAutomaticReconnect: 0,2s,5s,10s,then 30s steady. */
const RECONNECT_DELAYS_MS = [0, 2000, 5000, 10000, 30000];

export function createAircraftHubConnection(config: HubFactoryConfig): HubConnection {
  const getToken = config.getToken ?? getAccessTokenSync;
  return new HubConnectionBuilder()
    .withUrl(`${config.baseUrl.replace(/\/+$/, "")}/hubs/aircraft`, {
      transport: HttpTransportType.WebSockets,
      // Force WS: no negotiation fallback to SSE/long-poll on native.
      skipNegotiation: true,
      accessTokenFactory: () => getToken() ?? "",
    })
    .withAutomaticReconnect({
      nextRetryDelayInMilliseconds: (ctx) =>
        RECONNECT_DELAYS_MS[Math.min(ctx.previousRetryCount, RECONNECT_DELAYS_MS.length - 1)],
    })
    .configureLogging(config.logLevel ?? LogLevel.Warning)
    .build();
}

export interface AircraftSubscription {
  lat: number;
  lon: number;
  radiusKm: number;
}

/** Register the snapshot handler; returns an unsubscribe. */
export function onSnapshot(
  connection: HubConnection,
  handler: (aircraft: AircraftDto[]) => void,
): () => void {
  connection.on("snapshot", handler);
  return () => connection.off("snapshot", handler);
}

/** A status frame: the server has no snapshot this tick (e.g. away-mode unavailable). */
export interface HubStatus {
  reason: string;
}

/**
 * Register the status handler; returns an unsubscribe. The server sends "status" instead of
 * "snapshot" when it can't serve aircraft — no own-feed matches AND away-mode unavailable
 * (budget/unconfigured/upstream). Registering it also silences SignalR's "no client method
 * 'status'" warning.
 */
export function onStatus(
  connection: HubConnection,
  handler: (status: HubStatus) => void,
): () => void {
  connection.on("status", handler);
  return () => connection.off("status", handler);
}

/** Send a subscription request to the hub (server throttles to 1/10 s). */
export function subscribe(
  connection: HubConnection,
  sub: AircraftSubscription,
): Promise<void> {
  return connection.invoke("Subscribe", sub.lat, sub.lon, sub.radiusKm);
}
