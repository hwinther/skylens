/**
 * Satellite data + propagation hook for the AR overlay.
 *
 * Splits the work by cadence, mirroring the app-wide rule that heavy math never rides the pose loop:
 *  - SLOW (fetch): pull the CelesTrak OMM snapshot from the backend once, refetch every 6 h, on
 *    app re-activation, and immediately when sign-in completes. Failures fail soft to empty and
 *    retry on an escalating backoff (10 s doubling to a 5 min cap) — the cold-start failures
 *    (401 racing token hydration, 503/timeout while the backend's first CelesTrak fetch warms)
 *    resolve in seconds, so a flat long backoff left the AR view empty while the later-mounted
 *    list screen's own hook instance fetched successfully.
 *    buildSatrecs (json2satrec × N) runs ONCE per payload, memoised.
 *  - 1 Hz (propagate): a setInterval re-runs SGP4 + the ECI→ECF→look-angle transforms for every
 *    satellite and selects the visible set. SGP4 is FAR too heavy for the 60 Hz rAF overlay, so it is
 *    confined here; the overlay only re-projects the precomputed azimuth/elevation each frame.
 *
 * Frequently-changing inputs (observer, groups, mask) are mirrored into refs so the 1 Hz interval
 * starts once and reads fresh values without restarting — the same discipline usePoseRefs/ArOverlay
 * use. The interval only runs while enabled, an observer is known, and satrecs are built.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import type { ApiClient } from "@/api/client";
import type { SatelliteDto } from "@/api/types";
import { useAuthStore } from "@/state/authStore";
import {
  buildSatrecs,
  propagateAll,
  selectVisible,
  type Observer,
  type SatelliteView,
  type SatGroup,
  type SatrecEntry,
} from "@/ar";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const INITIAL_RETRY_MS = 10 * 1000;
const MAX_RETRY_MS = 5 * 60 * 1000;
const PROPAGATE_INTERVAL_MS = 1000;

/**
 * Fetch-retry delay for the Nth consecutive failure (0-based): 10 s doubling to a 5 min cap.
 * Short early retries recover the cold-start failures within seconds; the cap keeps a
 * genuinely-down backend from being hammered. Exported for tests.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * 2 ** attempt);
}

export type SatelliteStatus = "ok" | "loading" | "unavailable";

export interface UseSatellitesOptions {
  /** Typed API client (same instance the screen builds for the detail sheet). */
  client: ApiClient;
  /** Observer position for propagation; null until a GPS/demo fix is known. */
  observer: Observer | null;
  /** Master toggle (= showSatellites). When false the hook idles and reports "unavailable". */
  enabled: boolean;
  /** Enabled satellite groups; a satellite in a disabled group is filtered out. */
  groups: Set<SatGroup>;
  /** Elevation mask in degrees — satellites lower than this above the horizon are hidden. */
  elevationMaskDeg: number;
  /** Injectable timers for tests (mirrors startMockFeed). Default to the globals. */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** Injectable clock for deterministic tests. Defaults to the wall clock. */
  now?: () => Date;
}

export interface UseSatellitesResult {
  /** The visible, group-filtered, priority-capped satellites at the last 1 Hz tick. */
  visible: SatelliteView[];
  /** Same set keyed by NORAD id (for the Phase 5 detail sheet lookup). */
  byNoradId: Map<number, SatelliteView>;
  /** Age of the backend TLE snapshot in seconds, or null before the first successful fetch. */
  tleAgeSeconds: number | null;
  /**
   * Epoch ms the current `visible` set was propagated at (captured at tick start from the propagation
   * clock). The overlay extrapolates az/el by `Date.now() - satellitesSampledAt`. 0 while idle/empty.
   */
  satellitesSampledAt: number;
  status: SatelliteStatus;
}

interface Payload {
  sats: SatelliteDto[];
  tleAgeSeconds: number;
}

interface PropagatedResult {
  visible: SatelliteView[];
  byNoradId: Map<number, SatelliteView>;
  /** Epoch ms this set was propagated at (from the tick's propagation clock); 0 for the empty set. */
  sampledAt: number;
}

// Stable empty singletons so an idle/empty hook returns the same references frame to frame.
const NO_VIEWS: SatelliteView[] = [];
const EMPTY_BY_ID: Map<number, SatelliteView> = new Map();
const EMPTY_RESULT: PropagatedResult = { visible: NO_VIEWS, byNoradId: EMPTY_BY_ID, sampledAt: 0 };
const defaultNow = () => new Date();

export function useSatellites(options: UseSatellitesOptions): UseSatellitesResult {
  const {
    client,
    observer,
    enabled,
    groups,
    elevationMaskDeg,
    setIntervalImpl,
    clearIntervalImpl,
    now = defaultNow,
  } = options;

  const [payload, setPayload] = useState<Payload | null>(null);
  const [fetchState, setFetchState] = useState<SatelliteStatus>("loading");
  const [result, setResult] = useState<PropagatedResult>(EMPTY_RESULT);

  // Sign-in completion re-runs the fetch effect below. The deployed app's cold start races this
  // hook's first fetch against token hydration/sign-in: that 401 used to park the always-mounted
  // AR screen in a flat 5-minute backoff, while the list screen — mounted after sign-in — fetched
  // fine with its own hook instance ("satellites in list but not in AR").
  const isAuthenticated = useAuthStore((s) => s.status === "authenticated");

  // --- SLOW: fetch the OMM snapshot; refetch on 6 h timer / app re-activation / sign-in; back off
  // on failure (escalating, see retryDelayMs). All state updates live in the async .then/.catch
  // (never synchronously in the effect body) so this stays clear of react-hooks/set-state-in-effect;
  // "loading" is the initial fetchState. When disabled we simply idle — the derived
  // `status`/`visible` below mask any stale payload to empty.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let refetchTimer: ReturnType<typeof setTimeout> | undefined;
    let failedAttempts = 0;

    const load = () => {
      client
        .satellites()
        .then((res) => {
          if (cancelled) return;
          failedAttempts = 0;
          setPayload({ sats: res.satellites ?? [], tleAgeSeconds: res.tleAgeSeconds ?? 0 });
          setFetchState("ok");
          refetchTimer = setTimeout(load, SIX_HOURS_MS);
        })
        .catch(() => {
          if (cancelled) return;
          // Fail soft (incl. 401 signed-out / 503 no-snapshot-yet): drop to empty and retry on the
          // escalating schedule — cold-start failures clear in seconds, real outages hit the cap.
          setPayload(null);
          setFetchState("unavailable");
          refetchTimer = setTimeout(load, retryDelayMs(failedAttempts++));
        });
    };

    load();

    // Refetch when the app returns to the foreground — native uses RN AppState; web uses the page
    // Visibility API (RN AppState has no lifecycle there). Both are no-op safe under jest/node.
    let removeActivation: (() => void) | undefined;
    if (Platform.OS === "web") {
      if (typeof document !== "undefined") {
        const onVisible = () => {
          if (document.visibilityState === "visible") load();
        };
        document.addEventListener("visibilitychange", onVisible);
        removeActivation = () => document.removeEventListener("visibilitychange", onVisible);
      }
    } else {
      const sub = AppState.addEventListener("change", (state) => {
        if (state === "active") load();
      });
      removeActivation = () => sub.remove();
    }

    return () => {
      cancelled = true;
      if (refetchTimer) clearTimeout(refetchTimer);
      removeActivation?.();
    };
  }, [enabled, client, isAuthenticated]);

  // buildSatrecs (json2satrec × N) is the expensive part — run it once per fetched payload only.
  const entries = useMemo<SatrecEntry[]>(
    () => (payload ? buildSatrecs(payload.sats) : []),
    [payload],
  );

  // Mirror fast-changing inputs into refs so the 1 Hz interval reads fresh values without restarting.
  const observerRef = useRef(observer);
  const groupsRef = useRef(groups);
  const maskRef = useRef(elevationMaskDeg);
  const entriesRef = useRef(entries);
  const nowRef = useRef(now);
  useEffect(() => {
    observerRef.current = observer;
    groupsRef.current = groups;
    maskRef.current = elevationMaskDeg;
    entriesRef.current = entries;
    nowRef.current = now;
  }, [observer, groups, elevationMaskDeg, entries, now]);

  // --- 1 Hz: propagate + select. Restarts only when the run-gate crosses on/off, not every render. ---
  // setState happens only inside `tick` (a called function, not the effect body) — again clear of the
  // set-state-in-effect rule; when the gate is off the derived return below masks to empty.
  const shouldRun = enabled && observer != null && entries.length > 0;
  useEffect(() => {
    if (!shouldRun) return;
    const setIntervalFn = setIntervalImpl ?? setInterval;
    const clearIntervalFn = clearIntervalImpl ?? clearInterval;

    const tick = () => {
      const obs = observerRef.current;
      if (!obs) return;
      // One clock read per tick: the same instant both drives propagation and stamps the sample, so the
      // overlay's Date.now()-based extrapolation age is measured against exactly what was propagated.
      const sampleDate = nowRef.current();
      const views = propagateAll(entriesRef.current, obs, sampleDate);
      const visible = selectVisible(views, maskRef.current, groupsRef.current);
      setResult({
        visible,
        byNoradId: new Map(visible.map((v) => [v.noradId, v])),
        sampledAt: sampleDate.getTime(),
      });
    };

    tick(); // immediate first placement
    const timer = setIntervalFn(tick, PROPAGATE_INTERVAL_MS);
    return () => clearIntervalFn(timer);
  }, [shouldRun, setIntervalImpl, clearIntervalImpl]);

  // Mask the last propagated set to empty whenever the gate is off (disabled / no observer / no
  // satrecs) so a stale set never lingers on screen. "ok" is implied by having a payload; otherwise
  // fetchState distinguishes first-load "loading" from a failed "unavailable".
  return {
    visible: shouldRun ? result.visible : NO_VIEWS,
    byNoradId: shouldRun ? result.byNoradId : EMPTY_BY_ID,
    tleAgeSeconds: payload?.tleAgeSeconds ?? null,
    satellitesSampledAt: shouldRun ? result.sampledAt : 0,
    status: !enabled ? "unavailable" : payload ? "ok" : fetchState,
  };
}
