/**
 * Live SignalR feed wiring — the counterpart to the demo mock feed. When enabled (live
 * mode) it opens the /hubs/aircraft connection, mirrors the connection state into the
 * aircraft store, pushes each 1 Hz "snapshot" into setSnapshot, and (re)subscribes with
 * the observer position + radius. The hub throttles Subscribe to 1/10 s, so re-subscribing
 * on a position change is cheap.
 *
 * The 60 Hz pose stays in refs (see usePoseRefs); only the slow-moving observer position
 * drives the subscription here.
 */

import { useCallback, useEffect, useRef } from "react";
import { HubConnectionState, type HubConnection } from "@microsoft/signalr";
import { createAircraftHubConnection, onSnapshot, onStatus, onVessels, subscribe } from "@/api/signalr";
import { flushClientLog } from "@/api/clientLog";
import { useAircraftStore } from "@/state/aircraftStore";
import { useVesselStore } from "@/state/vesselStore";
import { useAuthStore } from "@/state/authStore";

export interface LiveObserver {
  lat: number;
  lon: number;
}

export interface UseLiveFeedOptions {
  /** Connect only when true (live mode). Demo mode leaves this false. */
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
  const setConnection = useAircraftStore((s) => s.setConnection);
  const setSource = useAircraftStore((s) => s.setSource);
  // Vessels ride this same connection (the "vessels" message) but live in their own store.
  const setVessels = useVesselStore((s) => s.setSnapshot);
  const clearVessels = useVesselStore((s) => s.clear);
  // In production the hub requires a bearer (RequireAuthorization), so an anonymous connect 401s
  // at the WS handshake. accessTokenFactory reads the token store at connect time, but a FAILED
  // start is never retried — so sign-in/out must tear the connection down and reconnect. Keyed on
  // the boolean (not the raw status) so unknown→unauthenticated and the transient "authenticating"
  // state don't flap the connection; environments where sign-in never happens (preview DevAuth,
  // container e2e) see a constant false and behave exactly as before.
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
    // away-mode unavailable) — clear both lists so stale aircraft/ships don't linger, and it
    // silences SignalR's "no client method 'status'" warning.
    const offStatus = onStatus(conn, () => {
      setSnapshot([]);
      clearVessels();
    });
    conn.onreconnecting(() => setConnection("reconnecting"));
    conn.onreconnected(() => {
      setConnection("connected");
      void subscribeNow();
      // Hub connectivity is back — flush any client failures buffered during the outage.
      void flushClientLog(baseUrl);
    });
    conn.onclose(() => {
      setConnection("disconnected");
      clearVessels();
    });

    let cancelled = false;
    setConnection("connecting");
    // Dev aid: surface the resolved hub URL so device networking is debuggable from the Metro log.
    if (__DEV__) console.log(`[skylens] hub connecting → ${baseUrl}/hubs/aircraft`);
    conn
      .start()
      .then(() => {
        if (cancelled) return;
        setConnection("connected");
        void flushClientLog(baseUrl);
        return subscribeNow();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setConnection("disconnected");
        console.warn("hub start failed", err);
      });

    return () => {
      cancelled = true;
      offSnapshot();
      offVessels();
      offStatus();
      clearVessels();
      connRef.current = null;
      setConnection("disconnected");
      void conn.stop();
    };
  }, [
    enabled,
    baseUrl,
    authenticated,
    setSnapshot,
    setVessels,
    clearVessels,
    setConnection,
    setSource,
    subscribeNow,
  ]);

  // Re-subscribe when the observer position or radius changes (hub throttles to 1/10 s).
  useEffect(() => {
    void subscribeNow();
  }, [observer?.lat, observer?.lon, radiusKm, subscribeNow]);
}
