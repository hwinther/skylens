/**
 * SimTracker: turns 1 Hz (aircraft) / 5 s (vessel) samples into a smooth 60 fps camera pose.
 *
 * Between samples it dead-reckons the latest one forward (deadReckon from src/ar/smoothing). When a new
 * sample arrives the prediction and the new truth usually disagree by a few metres; instead of jumping,
 * the difference is kept as an offset that fades out over BLEND_MS. Heading and pitch are low-passed with
 * a time constant so turns ease in. Dead reckoning stops after MAX_EXTRAPOLATE_S without a new sample:
 * the camera holds there and `stale` tells the HUD the signal is lost.
 */

import { angleDiff, normalizeAzimuth } from "@/ar/geo";
import { deadReckon, FPM_TO_MPS, KNOTS_TO_MPS } from "@/ar/smoothing";
import { clampToTerrain, pitchFor, type SimPose, type SimSample } from "./simPose";

/** How long a correction takes to fade out. */
export const BLEND_MS = 1000;

/** Dead reckoning stops this long after the last sample. */
export const MAX_EXTRAPOLATE_S = 30;

/** A sample older than this marks the pose stale ("signal lost"). */
export const STALE_AFTER_S = 15;

/** Above this ground speed a repeated identical position is treated as "no new position". */
export const MOVING_MPS = 1;

/** Time constant for the heading / pitch low-pass. */
export const ANGLE_TAU_S = 0.6;

export interface TrackedPose extends SimPose {
  /** Speed over the ground from the latest sample, m/s. */
  speedMps: number;
  /** Seconds since the latest sample was true. */
  ageS: number;
  stale: boolean;
}

interface Offset {
  dLat: number;
  dLon: number;
  dAlt: number;
  atMs: number;
}

export class SimTracker {
  private sample: SimSample | null = null;
  private offset: Offset | null = null;
  private heading: number | null = null;
  private pitch: number | null = null;
  private lastPoseMs: number | null = null;

  get latest(): SimSample | null {
    return this.sample;
  }

  /** Feed a new sample. `nowMs` is the render clock at the moment it arrives. */
  update(sample: SimSample, nowMs: number): void {
    const prev = this.sample;
    if (prev && sample.timeMs < prev.timeMs) return; // out of order
    // A MOVING object reporting exactly the same position again carries no new position: the snapshot
    // just repeated it (a position message hadn't arrived yet, or a replayed fixture). Taking it as-is
    // would drag the camera back to where the object was. Keep the original position and its time, so
    // dead reckoning carries on and the position keeps ageing (the HUD goes stale if nothing new comes),
    // but take the new velocity: a turn or climb can arrive before the next position. A stationary
    // object (moored vessel, parked aircraft) legitimately repeats its position, so that is accepted.
    if (prev && sample.lat === prev.lat && sample.lon === prev.lon && sample.speedMps > MOVING_MPS) {
      sample = { ...sample, altM: prev.altM, timeMs: prev.timeMs };
    }
    // What the camera would show right now from the previous state (its prediction plus whatever is left
    // of its own correction). Comparing against this, not the last rendered frame, keeps the hand-over
    // seamless however long ago that frame was drawn.
    const shown = prev ? this.positionAt(prev, nowMs) : null;
    this.sample = sample;
    if (shown) {
      const fresh = this.predict(sample, nowMs);
      this.offset = {
        dLat: shown.lat - fresh.lat,
        dLon: wrapLon(shown.lon - fresh.lon),
        dAlt: shown.alt - fresh.alt,
        atMs: nowMs,
      };
    }
  }

  /** `s` dead-reckoned to `nowMs`, plus the part of the current correction not yet faded out. */
  private positionAt(s: SimSample, nowMs: number) {
    const p = this.predict(s, nowMs);
    const o = this.offset;
    const k = o ? 1 - (nowMs - o.atMs) / BLEND_MS : 0;
    if (!o || k <= 0) return p;
    return { lat: p.lat + o.dLat * k, lon: p.lon + o.dLon * k, alt: p.alt + o.dAlt * k };
  }

  /** The camera pose at `nowMs`, or null before the first sample. `terrainM` keeps it above ground. */
  pose(nowMs: number, terrainM?: number | null): TrackedPose | null {
    const s = this.sample;
    if (!s) return null;

    const { lat, lon, alt } = this.positionAt(s, nowMs);
    if (this.offset && nowMs - this.offset.atMs >= BLEND_MS) this.offset = null;

    // Time-constant low-pass on the angles, so behaviour doesn't depend on the frame rate.
    const dtS = this.lastPoseMs == null ? 0 : Math.max(0, (nowMs - this.lastPoseMs) / 1000);
    this.lastPoseMs = nowMs;
    const a = dtS > 0 ? 1 - Math.exp(-dtS / ANGLE_TAU_S) : 1;
    const targetPitch = pitchFor(s);
    this.heading =
      this.heading == null ? s.headingDeg : normalizeAzimuth(this.heading + a * angleDiff(s.headingDeg, this.heading));
    this.pitch = this.pitch == null ? targetPitch : this.pitch + a * (targetPitch - this.pitch);

    const ageS = Math.max(0, (nowMs - s.timeMs) / 1000);
    return {
      lat,
      lon: wrapLon(lon),
      altM: clampToTerrain(alt, terrainM),
      headingDeg: this.heading,
      pitchDeg: this.pitch,
      speedMps: s.speedMps,
      ageS,
      stale: ageS > STALE_AFTER_S,
    };
  }

  private predict(s: SimSample, nowMs: number) {
    const dtS = Math.min(MAX_EXTRAPOLATE_S, Math.max(0, (nowMs - s.timeMs) / 1000));
    return deadReckon(
      {
        lat: s.lat,
        lon: s.lon,
        alt: s.altM,
        gs: s.speedMps / KNOTS_TO_MPS,
        trk: s.headingDeg,
        vr: s.vertMps / FPM_TO_MPS,
      },
      dtS,
    );
  }
}

function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
