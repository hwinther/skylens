/**
 * Live SignalR feed wiring — the counterpart to the demo mock feed. When enabled (live
 * mode) it opens the /hubs/aircraft connection, mirrors the connection state into the
 * aircraft store, pushes each 1 Hz "snapshot" into setSnapshot, and (re)subscribes with
 * the observer position + radius. The hub throttles Subscribe to 1/10 s, so re-subscribing
 * on a position change is cheap.
 *
 * The 60 Hz pose stays in refs (see usePoseRefs); only the slow-moving observer position
 * drives the subscription here.
 *
 * The root layout enables it only in live mode AND while the API may be called (useApiAllowed): with
 * real auth and no session it stays off and the sign-in card shows instead of a hub that 401s forever.
 * Turning it off (sign-out, switching to demo) clears the aircraft and vessels it delivered.
 */

import { useCallback, useEffect, useRef } from "react";
import { HubConnectionState, type HubConnection } from "@microsoft/signalr";
import {
  createAircraftHubConnection,
  onSnapshot,
  onStatus,
  onVessels,
  RECONNECT_DELAYS_MS,
  subscribe,
} from "@/api/signalr";
import { flushClientLog } from "@/api/clientLog";
import { useAircraftStore } from "@/state/aircraftStore";
import { useVesselStore } from "@/state/vesselStore";
import { useAuthStore } from "@/state/authStore";

export interface LiveObserver {
  lat: number;
  lon: number;
}

export interface UseLiveFeedOptions {
  /** Connect only when true (live mode with API access). Demo mode leaves this false. */
  enabled: boolean;
  /** Backend base URL. */
  baseUrl: string;
  /** Subscription centre; null until a position (GPS/config) is known — no subscribe yet. */
  observer: LiveObserver | null;
  /** Subscription radius in km. */
  radiusKm: number;
}

export function useLiveFeed({ enabled, baseUrl, observer, radiusKm }: UseLiveFeedOptions): void {
  const setSnapshot = useAircraftStore((s) => s.setSnapshot);
  const setFeedStatus = useAircraftStore((s) => s.setFeedStatus);
  const setConnection = useAircraftStore((s) => s.setConnection);
  const setSource = useAircraftStore((s) => s.setSource);
  const clearAircraft = useAircraftStore((s) => s.clear);
  // Vessels ride this same connection (the "vessels" message) but live in their own store.
  const setVessels = useVesselStore((s) => s.setSnapshot);
  const clearVessels = useVesselStore((s) => s.clear);
  // In production the hub requires a bearer (RequireAuthorization); the caller keeps this hook
  // disabled until there is a session. Sign-in/out still tears the connection down so the new token
  // is used straight away. Keyed on the boolean (not the raw status) so unknown→unauthenticated and
  // the transient "authenticating" state don't flap the connection; environments where sign-in never
  // happens (DevAuth: local dev, e2e, previews) see a constant false.
  const authenticated = useAuthStore((s) => s.status === "authenticated");

  const connRef = useRef<HubConnection | null>(null);
  // Latest observer/radius held in refs so re-subscribing never tears the connection down.
  // Synced in an effect (not during render) and declared first so it commits before the
  // connection/subscribe effects below read the refs.
  const observerRef = useRef(observer);
  const radiusRef = useRef(radiusKm);
  useEffect(() => {
    observerRef.current = observer;
    radiusRef.current = radiusKm;
  }, [observer, radiusKm]);

  const subscribeNow = useCallback(async () => {
    const conn = connRef.current;
    const obs = observerRef.current;
    if (!conn || conn.state !== HubConnectionState.Connected || !obs) return;
    try {
      await subscribe(conn, { lat: obs.lat, lon: obs.lon, radiusKm: radiusRef.current });
    } catch (err) {
      console.warn("hub subscribe failed", err);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setSource("live");

    const conn = createAircraftHubConnection({ baseUrl });
    connRef.current = conn;
    const offSnapshot = onSnapshot(conn, (aircraft) => setSnapshot(aircraft));
    const offVessels = onVessels(conn, (vessels) => setVessels(vessels));
    // A "status" frame means the server has no aircraft for us this tick (own feed empty and
    // away-mode unavailable): clear the aircraft and keep the reason for the UI. Ships are left
    // alone — the frame is aircraft-only and arrives every second, while vessels come every 5 s,
    // so clearing them here made ships flicker out whenever aircraft away mode was unavailable.
    const offStatus = onStatus(conn, (status) => setFeedStatus(status.reason));
    conn.onreconnecting(() => setConnection("reconnecting"));
    conn.onreconnected(() => {
      setConnection("connected");
      void subscribeNow();
      // Hub connectivity is back — flush any client failures buffered during the outage.
      void flushClientLog(baseUrl);
    });
    let cancelled = false;
    let failedStarts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // withAutomaticReconnect only covers a connection that was up. A start() that fails (backend
    // restarting, network blip, token rejected at the handshake) would otherwise leave the app
    // connected to nothing until the auth status flipped, so retry it on the same backoff
    // schedule (2 s, 5 s, 10 s, then every 30 s; a close after a good connection restarts at once).
    const scheduleStart = () => {
      if (cancelled) return;
      if (retryTimer) clearTimeout(retryTimer);
      const delay = RECONNECT_DELAYS_MS[Math.min(failedStarts, RECONNECT_DELAYS_MS.length - 1)];
      retryTimer = setTimeout(start, delay);
    };

    const start = () => {
      retryTimer = null;
      if (cancelled || conn.state !== HubConnectionState.Disconnected) return;
      setConnection("connecting");
      // Dev aid: surface the resolved hub URL so device networking is debuggable from the Metro log.
      if (__DEV__) console.log(`[skylens] hub connecting → ${baseUrl}/hubs/aircraft`);
      conn
        .start()
        .then(() => {
          if (cancelled) return;
          failedStarts = 0;
          setConnection("connected");
          void flushClientLog(baseUrl);
          return subscribeNow();
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setConnection("disconnected");
          console.warn("hub start failed", err);
          failedStarts++;
          scheduleStart();
        });
    };

    conn.onclose(() => {
      setConnection("disconnected");
      clearVessels();
      // Closed for good (the server ended the connection, or automatic reconnect gave up): start
      // over rather than staying dark. Not reached on unmount, where `cancelled` is already set.
      scheduleStart();
    });

    start();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      offSnapshot();
      offVessels();
      offStatus();
      clearVessels();
      // Don't leave the last live snapshot on screen after sign-out or a switch to demo (the demo
      // feed repopulates the same store when it starts).
      clearAircraft();
      connRef.current = null;
      setConnection("disconnected");
      void conn.stop();
    };
  }, [
    enabled,
    baseUrl,
    authenticated,
    setSnapshot,
    setFeedStatus,
    setVessels,
    clearVessels,
    clearAircraft,
    setConnection,
    setSource,
    subscribeNow,
  ]);

  // Re-subscribe when the observer position or radius changes (hub throttles to 1/10 s).
  useEffect(() => {
    void subscribeNow();
  }, [observer?.lat, observer?.lon, radiusKm, subscribeNow]);
}
