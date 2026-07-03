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
import { createAircraftHubConnection, onSnapshot, subscribe } from "@/api/signalr";
import { useAircraftStore } from "@/state/aircraftStore";

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
    conn.onreconnecting(() => setConnection("reconnecting"));
    conn.onreconnected(() => {
      setConnection("connected");
      void subscribeNow();
    });
    conn.onclose(() => setConnection("disconnected"));

    let cancelled = false;
    setConnection("connecting");
    conn
      .start()
      .then(() => {
        if (cancelled) return;
        setConnection("connected");
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
      connRef.current = null;
      setConnection("disconnected");
      void conn.stop();
    };
  }, [enabled, baseUrl, setSnapshot, setConnection, setSource, subscribeNow]);

  // Re-subscribe when the observer position or radius changes (hub throttles to 1/10 s).
  useEffect(() => {
    void subscribeNow();
  }, [observer?.lat, observer?.lon, radiusKm, subscribeNow]);
}
