/**
 * Upcoming sky-events hook for the List screen's "Upcoming" section.
 *
 * Unlike the spatial hooks (usePlanets/useRadioSky/useSatellites) this feed does NOT move on a human
 * timescale: equinoxes, eclipses, oppositions and supermoons are days-to-years apart. So the whole list
 * is computed ONCE per (enabled, observer-changed) and merely REFRESHED on a coarse 1-hour interval —
 * enough to drop a just-passed event and keep the "in N days" countdowns honest, but nowhere near the
 * per-30 s recompute the spatial hooks do (a year of eclipse searches every tick would be very costly).
 *
 * The feed is mostly observer-INDEPENDENT (seasons/oppositions/elongations), so it computes even when
 * `observer` is null — only the eclipse rows need a location, and computeSkyEvents simply omits them
 * without one. Compute is gated on `enabled` alone. The observer is mirrored into a ref so the interval
 * reads fresh values without restarting; a change of observer identity re-seeds the compute. When
 * disabled the hook idles and returns a stable-empty array so a re-render never churns.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { computeSkyEvents, type SkyEvent, type SkyEventObserver } from "@/ar";

/** Refresh cadence: events shift on the scale of days, so an hourly re-search keeps countdowns right. */
const SKY_EVENTS_INTERVAL_MS = 3_600_000;

export interface UseSkyEventsOptions {
  /** Observer position for the eclipse (visibility-gated) rows; null still yields seasons/planets. */
  observer: SkyEventObserver | null;
  /** Master toggle (= showSkyEvents). When false the hook idles and returns stable-empty. */
  enabled: boolean;
  /** Injectable timers for tests. Default to the globals. */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** Injectable clock for deterministic tests. Defaults to the wall clock. */
  now?: () => Date;
}

export interface UseSkyEventsResult {
  /** The upcoming events, ascending by date; stable-empty while idle/disabled. */
  events: SkyEvent[];
  /** Epoch ms the current list was computed at; 0 while idle. */
  computedAt: number;
}

interface ComputedResult {
  events: SkyEvent[];
  computedAt: number;
}

// Stable empty singletons so an idle/disabled hook returns the same references frame to frame.
const NO_EVENTS: SkyEvent[] = [];
const EMPTY_RESULT: ComputedResult = { events: NO_EVENTS, computedAt: 0 };
const defaultNow = () => new Date();

export function useSkyEvents(options: UseSkyEventsOptions): UseSkyEventsResult {
  const { observer, enabled, setIntervalImpl, clearIntervalImpl, now = defaultNow } = options;

  const [result, setResult] = useState<ComputedResult>(EMPTY_RESULT);

  // Mirror the observer/clock into refs so the hourly interval reads fresh values without restarting.
  const observerRef = useRef(observer);
  const nowRef = useRef(now);
  useEffect(() => {
    observerRef.current = observer;
    nowRef.current = now;
  }, [observer, now]);

  // Compute once, then refresh hourly. The effect restarts (re-seeds an immediate compute) when the gate
  // flips OR the observer identity changes, so toggling the feed on / getting a first fix repopulates it.
  // setState lives only inside `tick` (a called function, not the effect body) so this stays clear of the
  // react-hooks set-state-in-effect rule; the derived return below masks to empty when disabled.
  useEffect(() => {
    if (!enabled) return;
    const setIntervalFn = setIntervalImpl ?? setInterval;
    const clearIntervalFn = clearIntervalImpl ?? clearInterval;

    const tick = () => {
      const sampleDate = nowRef.current();
      const events = computeSkyEvents(sampleDate, observerRef.current);
      setResult({ events, computedAt: sampleDate.getTime() });
    };

    tick(); // immediate first compute
    const timer = setIntervalFn(tick, SKY_EVENTS_INTERVAL_MS);
    return () => clearIntervalFn(timer);
  }, [enabled, observer, setIntervalImpl, clearIntervalImpl]);

  // Mask to empty whenever disabled so a stale list never lingers on screen.
  return useMemo<UseSkyEventsResult>(
    () =>
      enabled
        ? { events: result.events, computedAt: result.computedAt }
        : { events: NO_EVENTS, computedAt: 0 },
    [enabled, result],
  );
}
