/**
 * Fixed-radio-source ephemeris hook for the AR overlay's radio pass, the List "Radio" section and the
 * radio detail sheet.
 *
 * Like usePlanets there is NO fetch and NO element sets: the four sources are a pure function of the
 * observer + instant (computeRadioSky), so this hook is a single recompute on a timer. They are FIXED
 * on the sky and drift only with Earth's rotation, so a 30 s cadence is far finer than the eye (or an
 * antenna) can tell. computeRadioSky returns all four; we keep only those above the horizon as
 * `visible` (the overlay/list render the visible set; the detail sheet falls back to static facts when
 * a source is below the horizon).
 *
 * The observer is mirrored into a ref so the interval starts once and reads fresh values without
 * restarting (the same discipline usePlanets/useSatellites use). When disabled the hook idles and
 * returns stable-empty references so a re-render never churns.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { computeRadioSky, type RadioObserver, type RadioTargetView } from "@/ar";

/** Recompute cadence: fixed sources drift ~arc-minutes/minute with Earth's spin, so 30 s is ample. */
const RADIO_INTERVAL_MS = 30_000;

export interface UseRadioSkyOptions {
  /** Observer position for the ephemeris; null until a GPS/demo fix is known. */
  observer: RadioObserver | null;
  /** Master toggle (= showRadioSky). When false the hook idles and returns stable-empty. */
  enabled: boolean;
  /** Injectable timers for tests. Default to the globals. */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** Injectable clock for deterministic tests. Defaults to the wall clock. */
  now?: () => Date;
}

export interface UseRadioSkyResult {
  /** Sources above the horizon at the last tick. */
  visible: RadioTargetView[];
  /** Same set keyed by stable source key (for the detail-sheet lookup), e.g. "casA". */
  byKey: Map<string, RadioTargetView>;
  /** Epoch ms the current set was computed at; 0 while idle/empty. */
  sampledAt: number;
}

interface ComputedResult {
  visible: RadioTargetView[];
  byKey: Map<string, RadioTargetView>;
  sampledAt: number;
}

// Stable empty singletons so an idle/empty hook returns the same references frame to frame.
const NO_VIEWS: RadioTargetView[] = [];
const EMPTY_BY_KEY: Map<string, RadioTargetView> = new Map();
const EMPTY_RESULT: ComputedResult = {
  visible: NO_VIEWS,
  byKey: EMPTY_BY_KEY,
  sampledAt: 0,
};
const defaultNow = () => new Date();

export function useRadioSky(options: UseRadioSkyOptions): UseRadioSkyResult {
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
      // computeRadioSky returns all four (incl. below-horizon); keep only the visible ones here.
      const visible = computeRadioSky(obs, sampleDate).filter(
        (t) => Number.isFinite(t.elevationDeg) && t.elevationDeg >= 0,
      );
      setResult({
        visible,
        byKey: new Map(visible.map((v) => [v.key, v])),
        sampledAt: sampleDate.getTime(),
      });
    };

    tick(); // immediate first placement
    const timer = setIntervalFn(tick, RADIO_INTERVAL_MS);
    return () => clearIntervalFn(timer);
  }, [shouldRun, setIntervalImpl, clearIntervalImpl]);

  // Mask to empty whenever the gate is off so a stale set never lingers on screen.
  return useMemo<UseRadioSkyResult>(
    () =>
      shouldRun
        ? { visible: result.visible, byKey: result.byKey, sampledAt: result.sampledAt }
        : { visible: NO_VIEWS, byKey: EMPTY_BY_KEY, sampledAt: 0 },
    [shouldRun, result],
  );
}
