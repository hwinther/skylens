/**
 * Pure-TS kinematics for the simulator's cockpit camera.
 *
 * Every followed object (aircraft, helicopter, vessel, satellite) is normalised into one SimSample: a
 * position plus a velocity in SI units and the instant it was valid. SimTracker (./tracker) dead-reckons
 * a sample forward to render time and turns it into a SimPose: where the camera sits and which way it
 * looks. Kept free of react / react-native / Cesium so jest runs it anywhere.
 */

import type { AircraftDto, VesselDto } from "@/api/types";
import { normalizeAzimuth, rad2deg } from "@/ar/geo";
import type { SatelliteState } from "@/ar/satellites";
import { FPM_TO_MPS, KNOTS_TO_MPS } from "@/ar/smoothing";

export type SimKind = "aircraft" | "vessel" | "satellite";

export const FEET_TO_M = 0.3048;

/** Eye height for a vessel's camera above sea level (a bridge, roughly). */
export const VESSEL_EYE_M = 12;

/** The camera never goes below the terrain (when known) by less than this. */
export const MIN_CLEARANCE_M = 2;

/** An aircraft camera looks this far down from the flight path, like a pilot watching the ground ahead. */
export const AIRCRAFT_PITCH_DEG = -6;

/** Helicopters fly low and slow: look further down. ADS-B emitter category A7 = rotorcraft. */
export const HELICOPTER_PITCH_DEG = -15;

/** Flight-path pitch is clamped to this range (a 1 Hz baro rate can spike). */
export const MAX_PITCH_DEG = 25;

/**
 * A satellite's camera looks this far below the horizon (the limb), so the Earth fills most of the view
 * with a band of space above it. The horizon itself dips with altitude: ~20° from the ISS, ~76° from GNSS.
 */
export const SATELLITE_BELOW_HORIZON_DEG = 10;

const EARTH_RADIUS_M = 6_371_000;

/** Angle of the horizon below the local horizontal, seen from `altM` above a spherical Earth. */
export function horizonDipDeg(altM: number): number {
  if (!(altM > 0)) return 0;
  return rad2deg(Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + altM)));
}

/** AIS "heading not available". */
const AIS_NO_HEADING = 511;

export interface SimSample {
  lat: number;
  lon: number;
  /** Height above the ellipsoid, metres (baro altitude for aircraft: close enough for a view). */
  altM: number;
  /** Speed over the ground, m/s. */
  speedMps: number;
  /** Direction of travel, degrees true. */
  headingDeg: number;
  /** Climb rate, m/s (positive up). */
  vertMps: number;
  /** Camera pitch on top of the flight path, degrees (negative looks down). */
  basePitchDeg: number;
  /** Epoch ms at which this state was true. */
  timeMs: number;
}

export interface SimPose {
  lat: number;
  lon: number;
  altM: number;
  headingDeg: number;
  pitchDeg: number;
}

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * An aircraft DTO received at `receivedAtMs` as a sample. `seen` (seconds since the last message)
 * backdates it so dead reckoning starts from when the position was true. Null without a position.
 */
export function aircraftSample(ac: AircraftDto, receivedAtMs: number): SimSample | null {
  if (!finite(ac.lat) || !finite(ac.lon)) return null;
  const seenS = finite(ac.seen) ? Math.max(0, ac.seen) : 0;
  return {
    lat: ac.lat,
    lon: ac.lon,
    altM: finite(ac.alt) ? Math.max(0, ac.alt * FEET_TO_M) : 0,
    speedMps: finite(ac.gs) ? ac.gs * KNOTS_TO_MPS : 0,
    headingDeg: finite(ac.trk) ? normalizeAzimuth(ac.trk) : 0,
    vertMps: finite(ac.vr) ? ac.vr * FPM_TO_MPS : 0,
    basePitchDeg: ac.cat === "A7" ? HELICOPTER_PITCH_DEG : AIRCRAFT_PITCH_DEG,
    timeMs: receivedAtMs - seenS * 1000,
  };
}

/**
 * A vessel DTO as a sample. The camera looks where the bow points (`hdg`) when the transponder reports
 * it, else along the course over ground (`cog`).
 */
export function vesselSample(v: VesselDto, receivedAtMs: number): SimSample | null {
  if (!finite(v.lat) || !finite(v.lon)) return null;
  const seenS = finite(v.seen) ? Math.max(0, v.seen) : 0;
  const hdg = finite(v.hdg) && v.hdg !== AIS_NO_HEADING && v.hdg >= 0 && v.hdg < 360 ? v.hdg : null;
  const cog = finite(v.cog) && v.cog >= 0 && v.cog < 360 ? v.cog : null;
  return {
    lat: v.lat,
    lon: v.lon,
    altM: VESSEL_EYE_M,
    speedMps: finite(v.sog) ? v.sog * KNOTS_TO_MPS : 0,
    headingDeg: hdg ?? cog ?? 0,
    vertMps: 0,
    basePitchDeg: 0,
    timeMs: receivedAtMs - seenS * 1000,
  };
}

/** A propagated satellite state (exact for `timeMs`) as a sample. */
export function satelliteSample(s: SatelliteState, timeMs: number): SimSample {
  return {
    lat: s.lat,
    lon: s.lon,
    altM: s.altKm * 1000,
    speedMps: s.groundSpeedKmS * 1000,
    headingDeg: s.headingDeg,
    vertMps: 0,
    basePitchDeg: -Math.min(89, horizonDipDeg(s.altKm * 1000) + SATELLITE_BELOW_HORIZON_DEG),
    timeMs,
  };
}

/** Camera pitch for a sample: its flight-path angle (clamped) plus the kind's base pitch. */
export function pitchFor(sample: SimSample): number {
  const fpa =
    sample.speedMps > 1 ? rad2deg(Math.atan2(sample.vertMps, sample.speedMps)) : 0;
  const clamped = Math.max(-MAX_PITCH_DEG, Math.min(MAX_PITCH_DEG, fpa));
  return sample.basePitchDeg + clamped;
}

/** Keep the camera at least MIN_CLEARANCE_M above the terrain height when that is known. */
export function clampToTerrain(altM: number, terrainM: number | null | undefined): number {
  if (!finite(terrainM)) return altM;
  return Math.max(altM, terrainM + MIN_CLEARANCE_M);
}
