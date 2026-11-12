/**
 * Smooth positions for moving objects fed by periodic snapshots (aircraft at 1 Hz, vessels every few s).
 *
 * `TrackedPosition` is the position core shared with the simulator's SimTracker:
 *  - A sample is timed by when its position was TRUE (`timeMs`, i.e. received time minus the position's
 *    own age), not by when the snapshot arrived, so it is dead-reckoned from the right instant.
 *  - A MOVING object repeating exactly the same position carries no new position (the snapshot just
 *    repeated it): the old position and its time are kept, only the velocity is taken.
 *  - The difference between what was shown and the new prediction is kept as an offset that fades out
 *    over BLEND_MS, so a new sample never shows as a jump. Optionally a correction larger than a sane
 *    distance snaps instead (a replay that loops, a source switch), so a label isn't smeared across
 *    the sky.
 *  - Dead reckoning stops a per-kind time after the sample (trackLimits).
 *
 * `PositionTracker` keeps one TrackedPosition per id, is fed once per snapshot (`sync`), forgets ids that
 * leave it, and answers `positionAt` per frame without allocating.
 *
 * Must import nothing from react-native / expo / react.
 */

import { deg2rad, METERS_PER_DEG } from "./geo";

/** How long a correction takes to fade out. */
export const BLEND_MS = 1000;

/** Above this ground speed a repeated identical position is treated as "no new position". */
export const MOVING_MPS = 1;

/** What is being tracked. The simulator's SimKind is this same type. */
export type TrackKind = "aircraft" | "vessel" | "satellite";

/**
 * How long a position stays trustworthy, per kind. Aircraft positions arrive every 1-3 s from the own
 * receiver, but away mode refetches every 10 s and the backend drops an aircraft after 60 s. Vessels
 * report far less often: class B every 30 s, anchored/moored ships every 3 min, BarentsWatch is
 * refetched every 60 s. Satellites are propagated every frame, so their limits never matter in practice.
 */
export const AIRCRAFT_STALE_AFTER_S = 30;
export const AIRCRAFT_MAX_EXTRAPOLATE_S = 60;
export const VESSEL_MOVING_STALE_AFTER_S = 120;
export const VESSEL_STATIONARY_STALE_AFTER_S = 420;
export const VESSEL_MAX_EXTRAPOLATE_S = 120;
export const SATELLITE_STALE_AFTER_S = 15;
export const SATELLITE_MAX_EXTRAPOLATE_S = 30;

export interface TrackLimits {
  /** After this many seconds without a new position the simulator HUD shows "Signal lost". */
  readonly staleAfterS: number;
  /** Dead reckoning stops this many seconds after the position was true. */
  readonly maxExtrapolateS: number;
}

const AIRCRAFT_LIMITS: TrackLimits = Object.freeze({
  staleAfterS: AIRCRAFT_STALE_AFTER_S,
  maxExtrapolateS: AIRCRAFT_MAX_EXTRAPOLATE_S,
});
const VESSEL_MOVING_LIMITS: TrackLimits = Object.freeze({
  staleAfterS: VESSEL_MOVING_STALE_AFTER_S,
  maxExtrapolateS: VESSEL_MAX_EXTRAPOLATE_S,
});
// A stationary vessel barely dead-reckons (speed <= MOVING_MPS); the cap only bounds a slow drift.
const VESSEL_STATIONARY_LIMITS: TrackLimits = Object.freeze({
  staleAfterS: VESSEL_STATIONARY_STALE_AFTER_S,
  maxExtrapolateS: VESSEL_MAX_EXTRAPOLATE_S,
});
const SATELLITE_LIMITS: TrackLimits = Object.freeze({
  staleAfterS: SATELLITE_STALE_AFTER_S,
  maxExtrapolateS: SATELLITE_MAX_EXTRAPOLATE_S,
});

/** The limits for a sample of `kind` moving at `speedMps`. Returns shared constants: never allocates. */
export function trackLimits(kind: TrackKind, speedMps: number): TrackLimits {
  switch (kind) {
    case "aircraft":
      return AIRCRAFT_LIMITS;
    case "vessel":
      return speedMps > MOVING_MPS ? VESSEL_MOVING_LIMITS : VESSEL_STATIONARY_LIMITS;
    case "satellite":
      return SATELLITE_LIMITS;
  }
}

/** AR snap guard: a correction always snaps beyond this many metres plus SNAP_SPEED_S of travel... */
export const SNAP_MIN_M = 500;

/** ...i.e. beyond SNAP_SPEED_S seconds at the object's speed. A real 1 Hz correction is far smaller. */
export const SNAP_SPEED_S = 5;

/** A position plus velocity in SI units and the epoch ms it was valid at. SimSample satisfies this. */
export interface PositionSample {
  /** What this is; with the speed it picks the extrapolation cap (trackLimits). */
  kind: TrackKind;
  lat: number;
  lon: number;
  /** Altitude, metres. */
  altM: number;
  /** Speed over the ground, m/s. */
  speedMps: number;
  /** Direction of travel, degrees true. */
  headingDeg: number;
  /** Climb rate, m/s (positive up). */
  vertMps: number;
  /** Epoch ms at which this position was true. */
  timeMs: number;
}

/** A mutable lat/lon/alt (metres) that positionAt writes into. */
export interface TrackPoint {
  lat: number;
  lon: number;
  alt: number;
}

export interface TrackOptions {
  /** A correction farther than `snapMinM + speedMps * snapSpeedS` metres snaps instead of blending. */
  snapMinM?: number;
  snapSpeedS?: number;
}

export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** `s` dead-reckoned to `nowMs` (capped by its kind's maxExtrapolateS), written into `out`. */
function predictInto(s: PositionSample, nowMs: number, out: TrackPoint): TrackPoint {
  const cap = trackLimits(s.kind, s.speedMps).maxExtrapolateS;
  const dtS = Math.min(cap, Math.max(0, (nowMs - s.timeMs) / 1000));
  if (dtS <= 0 || !Number.isFinite(s.speedMps) || !Number.isFinite(s.headingDeg)) {
    out.lat = s.lat;
    out.lon = s.lon;
    out.alt = s.altM;
    return out;
  }
  // Same local flat-earth step as smoothing.deadReckon, without its two allocations per call.
  const distanceM = s.speedMps * dtS;
  const trkRad = deg2rad(s.headingDeg);
  out.lat = s.lat + (distanceM * Math.cos(trkRad)) / METERS_PER_DEG;
  out.lon = s.lon + (distanceM * Math.sin(trkRad)) / (METERS_PER_DEG * Math.cos(deg2rad(s.lat)));
  out.alt = s.altM + (Number.isFinite(s.vertMps) ? s.vertMps : 0) * dtS;
  return out;
}

// Scratch points for update(): it runs synchronously, so module-level reuse is safe.
const shownScratch: TrackPoint = { lat: 0, lon: 0, alt: 0 };
const freshScratch: TrackPoint = { lat: 0, lon: 0, alt: 0 };

/** One object's smoothed position. */
export class TrackedPosition<T extends PositionSample = PositionSample> {
  private s: T | null = null;
  private hasOffset = false;
  private dLat = 0;
  private dLon = 0;
  private dAlt = 0;
  private atMs = 0;
  private readonly snapMinM: number;
  private readonly snapSpeedS: number;

  /** Without options a correction always blends, however large (the simulator's behaviour). */
  constructor(options: TrackOptions = {}) {
    this.snapMinM = options.snapMinM ?? Infinity;
    this.snapSpeedS = options.snapSpeedS ?? 0;
  }

  /** The sample in effect (after the repeated-position rule), or null before the first. */
  get sample(): T | null {
    return this.s;
  }

  /**
   * Feed a new sample; `nowMs` is the render clock at the moment it arrives. Returns the sample now in
   * effect (a copy keeping the previous position time when a moving object repeated its position), or
   * null when it was ignored as out of order.
   */
  update(sample: T, nowMs: number): T | null {
    const prev = this.s;
    if (prev && sample.timeMs < prev.timeMs) return null; // out of order
    // A moving object repeating its position: keep the original position and time so dead reckoning
    // carries on (and the position keeps ageing), but take the new velocity. A stationary object
    // (moored vessel, parked aircraft) legitimately repeats its position, so that is accepted.
    if (prev && sample.lat === prev.lat && sample.lon === prev.lon && sample.speedMps > MOVING_MPS) {
      sample = { ...sample, altM: prev.altM, timeMs: prev.timeMs };
    }
    // What would be shown right now from the previous state (its prediction plus what's left of its
    // own correction). Comparing against this, not the last rendered frame, keeps the hand-over
    // seamless however long ago that frame was drawn.
    const shown = prev ? this.positionAt(nowMs, shownScratch) : null;
    this.s = sample;
    if (shown) {
      const fresh = predictInto(sample, nowMs, freshScratch);
      this.dLat = shown.lat - fresh.lat;
      this.dLon = wrapLon(shown.lon - fresh.lon);
      this.dAlt = shown.alt - fresh.alt;
      this.atMs = nowMs;
      this.hasOffset = true;
      if (this.snapMinM !== Infinity) {
        const dN = this.dLat * METERS_PER_DEG;
        const dE = this.dLon * METERS_PER_DEG * Math.cos(deg2rad(fresh.lat));
        const limit = this.snapMinM + Math.max(0, sample.speedMps) * this.snapSpeedS;
        if (dN * dN + dE * dE > limit * limit) this.hasOffset = false; // teleport: snap, don't smear
      }
    }
    return sample;
  }

  /**
   * The sample dead-reckoned to `nowMs` plus the part of the current correction not yet faded out,
   * written into `out` (longitude not wrapped). Returns `out`, or null before the first sample.
   */
  positionAt(nowMs: number, out: TrackPoint): TrackPoint | null {
    const s = this.s;
    if (!s) return null;
    predictInto(s, nowMs, out);
    if (this.hasOffset) {
      const k = 1 - (nowMs - this.atMs) / BLEND_MS;
      if (k <= 0) {
        this.hasOffset = false; // faded out
      } else {
        out.lat += this.dLat * k;
        out.lon += this.dLon * k;
        out.alt += this.dAlt * k;
      }
    }
    return out;
  }
}

interface Entry<T extends PositionSample> {
  track: TrackedPosition<T>;
  gen: number;
}

/** Smoothed positions for many objects keyed by id (aircraft hex, vessel MMSI). */
export class PositionTracker<T extends PositionSample = PositionSample> {
  private readonly entries = new Map<string, Entry<T>>();
  private gen = 0;

  constructor(private readonly options: TrackOptions = { snapMinM: SNAP_MIN_M, snapSpeedS: SNAP_SPEED_S }) {}

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /**
   * Feed a whole snapshot. `sampleOf` returns null for an item without a usable position. Ids that are
   * not in the snapshot (or have no position in it) are forgotten.
   */
  sync<I>(items: readonly I[], idOf: (item: I) => string, sampleOf: (item: I) => T | null, nowMs: number): void {
    const gen = ++this.gen;
    for (const item of items) {
      const sample = sampleOf(item);
      if (!sample) continue;
      const id = idOf(item);
      let entry = this.entries.get(id);
      if (!entry) {
        entry = { track: new TrackedPosition<T>(this.options), gen };
        this.entries.set(id, entry);
      }
      entry.track.update(sample, nowMs);
      entry.gen = gen;
    }
    for (const [id, entry] of this.entries) {
      if (entry.gen !== gen) this.entries.delete(id);
    }
  }

  /** Writes `id`'s smoothed position at `nowMs` into `out` (lon wrapped). False for an unknown id. */
  positionAt(id: string, nowMs: number, out: TrackPoint): boolean {
    const entry = this.entries.get(id);
    if (!entry || !entry.track.positionAt(nowMs, out)) return false;
    out.lon = wrapLon(out.lon);
    return true;
  }

  clear(): void {
    this.entries.clear();
  }
}
