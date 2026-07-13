/**
 * Solar-System body ephemeris hook for the AR overlay's sky pass, the List "Sky" section and the planet
 * detail sheet.
 *
 * Unlike useSatellites there is NO fetch, NO element sets and NO extrapolation: the Sun, Moon and seven
 * planets are a pure function of the observer + instant (computePlanets), so this hook is a single
 * recompute on a timer. Bodies crawl at arc-minutes per minute, so a 30 s cadence is ample — nothing
 * here needs the per-frame dead-reckoning satellites do, and the whole recompute (nine bodies + the
 * ecliptic arc) is sub-millisecond.
 *
 * The observer is mirrored into a ref so the interval starts once and reads fresh values without
 * restarting (the same discipline useSatellites/ArOverlay use). When disabled the hook idles and
 * returns stable-empty references so a re-render never churns.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  computePlanets,
  eclipticLinePoints,
  type EclipticPoint,
  type PlanetObserver,
  type PlanetView,
} from "@/ar";

/** Recompute cadence: planets move ~arc-minutes/minute, so 30 s is far finer than the eye can tell. */
const PLANET_INTERVAL_MS = 30_000;

export interface UsePlanetsOptions {
  /** Observer position for the ephemeris; null until a GPS/demo fix is known. */
  observer: PlanetObserver | null;
  /** Master toggle (= showPlanets). When false the hook idles and returns stable-empty. */
  enabled: boolean;
  /** Injectable timers for tests. Default to the globals. */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** Injectable clock for deterministic tests. Defaults to the wall clock. */
  now?: () => Date;
}

export interface UsePlanetsResult {
  /** Bodies above the horizon at the last tick (Sun/Moon included when enabled). */
  visible: PlanetView[];
  /** Same set keyed by stable body key (for the detail-sheet lookup), e.g. "Mars". */
  byBody: Map<string, PlanetView>;
  /** Ecliptic arc samples for the faint sky line, recomputed on the same tick. */
  ecliptic: EclipticPoint[];
  /** Epoch ms the current set was computed at; 0 while idle/empty. */
  sampledAt: number;
}

interface ComputedResult {
  visible: PlanetView[];
  byBody: Map<string, PlanetView>;
  ecliptic: EclipticPoint[];
  sampledAt: number;
}

// Stable empty singletons so an idle/empty hook returns the same references frame to frame.
const NO_VIEWS: PlanetView[] = [];
const EMPTY_BY_BODY: Map<string, PlanetView> = new Map();
const NO_ECLIPTIC: EclipticPoint[] = [];
const EMPTY_RESULT: ComputedResult = {
  visible: NO_VIEWS,
  byBody: EMPTY_BY_BODY,
  ecliptic: NO_ECLIPTIC,
  sampledAt: 0,
};
const defaultNow = () => new Date();

export function usePlanets(options: UsePlanetsOptions): UsePlanetsResult {
  const { observer, enabled, setIntervalImpl, clearIntervalImpl, now = defaultNow } = options;

  const [result, setResult] = useState<ComputedResult>(EMPTY_RESULT);

  // Mirror the fast-changing observer into a ref so the interval reads fresh values without restarting.
  const observerRef = useRef(observer);
  const nowRef = useRef(now);
  useEffect(() => {
    observerRef.current = observer;
    nowRef.current = now;
  }, [observer, now]);

  // Recompute on a 30 s timer; restarts only when the run-gate crosses on/off, not every render.
  // setState happens only inside `tick` (a called function, not the effect body) so this stays clear of
  // the react-hooks set-state-in-effect rule; the derived return below masks to empty when off.
  const shouldRun = enabled && observer != null;
  useEffect(() => {
    if (!shouldRun) return;
    const setIntervalFn = setIntervalImpl ?? setInterval;
    const clearIntervalFn = clearIntervalImpl ?? clearInterval;

    const tick = () => {
      const obs = observerRef.current;
      if (!obs) return;
      const sampleDate = nowRef.current();
      const visible = computePlanets(obs, sampleDate);
      const ecliptic = eclipticLinePoints(obs, sampleDate);
      setResult({
        visible,
        byBody: new Map(visible.map((v) => [v.body, v])),
        ecliptic,
        sampledAt: sampleDate.getTime(),
      });
    };

    tick(); // immediate first placement
    const timer = setIntervalFn(tick, PLANET_INTERVAL_MS);
    return () => clearIntervalFn(timer);
  }, [shouldRun, setIntervalImpl, clearIntervalImpl]);

  // Mask to empty whenever the gate is off so a stale set never lingers on screen.
  return useMemo<UsePlanetsResult>(
    () =>
      shouldRun
        ? {
            visible: result.visible,
            byBody: result.byBody,
            ecliptic: result.ecliptic,
            sampledAt: result.sampledAt,
          }
        : { visible: NO_VIEWS, byBody: EMPTY_BY_BODY, ecliptic: NO_ECLIPTIC, sampledAt: 0 },
    [shouldRun, result],
  );
}
