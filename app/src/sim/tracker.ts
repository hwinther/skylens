/**
 * SimTracker: turns 1 Hz (aircraft) / 5 s (vessel) samples into a smooth 60 fps camera pose.
 *
 * The position part is the shared TrackedPosition core (src/ar/positionTracker): between samples it
 * dead-reckons the latest one forward; when a new sample arrives the prediction and the new truth usually
 * disagree by a few metres, and instead of jumping the difference is kept as an offset that fades out over
 * BLEND_MS. Dead reckoning stops a while without a new sample and the camera holds there; `stale` tells
 * the HUD the signal is lost. Both limits depend on what is followed (trackLimits). On top of that, heading and pitch are low-passed with a time
 * constant so turns ease in.
 */

import { angleDiff, normalizeAzimuth } from "@/ar/geo";
import { TrackedPosition, wrapLon, type TrackPoint } from "@/ar/positionTracker";
import { isSignalLost, sampleAgeS } from "@/ar/signalLost";
import { bankForTurn, clampToTerrain, pitchFor, type SimPose, type SimSample } from "./simPose";

export { BLEND_MS, MOVING_MPS, trackLimits } from "@/ar/positionTracker";

/** Time constant for the heading / pitch low-pass. */
export const ANGLE_TAU_S = 0.6;

/**
 * Time constant for the turn-rate low-pass behind the bank: the smoothed heading still steps a little at
 * each ~1 Hz sample, so the rate is smoothed again before it tilts the 3D model.
 */
export const TURN_RATE_TAU_S = 2.5;

export interface TrackedPose extends SimPose {
  /** Speed over the ground from the latest sample, m/s. */
  speedMps: number;
  /** Seconds since the latest sample was true. */
  ageS: number;
  stale: boolean;
  /** The flight-path angle under the camera's base pitch (pitchDeg without it), degrees. */
  pathPitchDeg?: number;
  /** Aircraft: the bank of a coordinated turn at the smoothed turn rate (right wing down +); else 0. */
  bankDeg?: number;
}

export class SimTracker {
  // No snap guard: the camera always blends a correction in, however large.
  private readonly position = new TrackedPosition<SimSample>();
  private readonly point: TrackPoint = { lat: 0, lon: 0, alt: 0 };
  private heading: number | null = null;
  private pitch: number | null = null;
  private turnRate = 0;
  private lastPoseMs: number | null = null;

  get latest(): SimSample | null {
    return this.position.sample;
  }

  /** Feed a new sample. `nowMs` is the render clock at the moment it arrives. */
  update(sample: SimSample, nowMs: number): void {
    this.position.update(sample, nowMs);
  }

  /** The camera pose at `nowMs`, or null before the first sample. `terrainM` keeps it above ground. */
  pose(nowMs: number, terrainM?: number | null): TrackedPose | null {
    const s = this.position.sample;
    if (!s || !this.position.positionAt(nowMs, this.point)) return null;
    const { lat, lon, alt } = this.point;

    // Time-constant low-pass on the angles, so behaviour doesn't depend on the frame rate.
    const dtS = this.lastPoseMs == null ? 0 : Math.max(0, (nowMs - this.lastPoseMs) / 1000);
    this.lastPoseMs = nowMs;
    const a = dtS > 0 ? 1 - Math.exp(-dtS / ANGLE_TAU_S) : 1;
    const targetPitch = pitchFor(s);
    const prevHeading = this.heading;
    this.heading =
      prevHeading == null ? s.headingDeg : normalizeAzimuth(prevHeading + a * angleDiff(s.headingDeg, prevHeading));
    this.pitch = this.pitch == null ? targetPitch : this.pitch + a * (targetPitch - this.pitch);
    if (prevHeading != null && dtS > 0) {
      const rate = angleDiff(this.heading, prevHeading) / dtS;
      this.turnRate += (1 - Math.exp(-dtS / TURN_RATE_TAU_S)) * (rate - this.turnRate);
    }

    const ageS = sampleAgeS(s, nowMs);
    return {
      lat,
      lon: wrapLon(lon),
      altM: clampToTerrain(alt, terrainM),
      headingDeg: this.heading,
      pitchDeg: this.pitch,
      speedMps: s.speedMps,
      ageS,
      stale: isSignalLost(s, nowMs),
      pathPitchDeg: this.pitch - s.basePitchDeg,
      bankDeg: s.kind === "aircraft" ? bankForTurn(s.speedMps, this.turnRate) : 0,
    };
  }
}
