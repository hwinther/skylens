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
  private last: TrackedPose | null = null;

  get latest(): SimSample | null {
    return this.sample;
  }

  /** Feed a new sample. `nowMs` is the render clock at the moment it arrives. */
  update(sample: SimSample, nowMs: number): void {
    if (this.sample && sample.timeMs < this.sample.timeMs) return; // out of order
    const shown = this.last;
    this.sample = sample;
    if (shown) {
      const fresh = this.predict(sample, nowMs);
      this.offset = {
        dLat: shown.lat - fresh.lat,
        dLon: wrapLon(shown.lon - fresh.lon),
        dAlt: shown.altM - fresh.alt,
        atMs: nowMs,
      };
    }
  }

  /** The camera pose at `nowMs`, or null before the first sample. `terrainM` keeps it above ground. */
  pose(nowMs: number, terrainM?: number | null): TrackedPose | null {
    const s = this.sample;
    if (!s) return null;

    const p = this.predict(s, nowMs);
    let { lat, lon, alt } = p;
    if (this.offset) {
      const k = 1 - (nowMs - this.offset.atMs) / BLEND_MS;
      if (k > 0) {
        lat += this.offset.dLat * k;
        lon += this.offset.dLon * k;
        alt += this.offset.dAlt * k;
      } else {
        this.offset = null;
      }
    }

    // Time-constant low-pass on the angles, so behaviour doesn't depend on the frame rate.
    const dtS = this.lastPoseMs == null ? 0 : Math.max(0, (nowMs - this.lastPoseMs) / 1000);
    this.lastPoseMs = nowMs;
    const a = dtS > 0 ? 1 - Math.exp(-dtS / ANGLE_TAU_S) : 1;
    const targetPitch = pitchFor(s);
    this.heading =
      this.heading == null ? s.headingDeg : normalizeAzimuth(this.heading + a * angleDiff(s.headingDeg, this.heading));
    this.pitch = this.pitch == null ? targetPitch : this.pitch + a * (targetPitch - this.pitch);

    const ageS = Math.max(0, (nowMs - s.timeMs) / 1000);
    this.last = {
      lat,
      lon: wrapLon(lon),
      altM: clampToTerrain(alt, terrainM),
      headingDeg: this.heading,
      pitchDeg: this.pitch,
      speedMps: s.speedMps,
      ageS,
      stale: ageS > STALE_AFTER_S,
    };
    return this.last;
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
