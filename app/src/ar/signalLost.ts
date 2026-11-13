/**
 * "Signal lost": whether a tracked object's position has gone stale, from the per-kind limits in
 * positionTracker (trackLimits). The one definition shared by the AR overlay (dimmed label, "lost · 45 s"
 * tag, dimmed edge arrow) and the simulator HUD ("Signal lost — holding last position").
 *
 * The age is measured from the sample IN EFFECT in the tracker, i.e. after its repeated-position rule:
 * the own feed keeps re-sending a quiet aircraft's last position with its last `seenPos`, so only the
 * tracker (which keeps the original position time) knows how old that position really is.
 *
 * Must import nothing from react-native / expo / react.
 */

import { trackLimits, type PositionSample } from "./positionTracker";

/** Under this age a position counts as live (the simulator HUD's "Live"); after it, it is dead-reckoned. */
export const LIVE_AGE_S = 3;

/**
 * fresh: a recent position. dead-reckoning: no new position for a while, moved along its last velocity.
 * lost: older than its kind's staleAfterS (it keeps dead-reckoning up to maxExtrapolateS, then holds).
 */
export type TrackPhase = "fresh" | "dead-reckoning" | "lost";

type AgedSample = Pick<PositionSample, "kind" | "speedMps" | "timeMs">;

/** Seconds since the sample's position was true (never negative). */
export function sampleAgeS(sample: Pick<PositionSample, "timeMs">, nowMs: number): number {
  return Math.max(0, (nowMs - sample.timeMs) / 1000);
}

/** True once the sample is older than its kind's staleAfterS. */
export function isSignalLost(sample: AgedSample, nowMs: number): boolean {
  return sampleAgeS(sample, nowMs) > trackLimits(sample.kind, sample.speedMps).staleAfterS;
}

export function trackPhase(sample: AgedSample, nowMs: number): TrackPhase {
  if (isSignalLost(sample, nowMs)) return "lost";
  return sampleAgeS(sample, nowMs) < LIVE_AGE_S ? "fresh" : "dead-reckoning";
}

/** Whole seconds since the position was true when the signal is lost, else null. */
export function lostAgeS(sample: AgedSample | null | undefined, nowMs: number): number | null {
  if (!sample || !isSignalLost(sample, nowMs)) return null;
  return Math.round(sampleAgeS(sample, nowMs));
}

/** A short age: "45 s" under 90 s, else "3 min" (a vessel can be minutes old before it counts as lost). */
export function formatAge(ageS: number): string {
  return ageS < 90 ? `${Math.round(ageS)} s` : `${Math.round(ageS / 60)} min`;
}

/** The AR label's tag for a lost target, e.g. "lost · 45 s". */
export function lostTag(ageS: number): string {
  return `lost · ${formatAge(ageS)}`;
}
