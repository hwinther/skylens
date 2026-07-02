/**
 * Demo-mode feed: replays the recorded dump1090-style snapshot series on a 1 Hz
 * timer, converting each frame's raw aircraft.json entries into the slim AircraftDto
 * the rest of the app consumes. The conversion mirrors the backend Dump1090Parser
 * gotchas (alt_baro "ground" string, space-padded flight, position-less aircraft,
 * float seen) so demo data exercises the same code paths as live data.
 *
 * The replay module itself is pure logic (no react-native) — the timer uses the
 * global setInterval, which exists under jest and RN alike — so it is unit-testable.
 */

import type { AircraftDto } from "@/api/types";
import recorded from "./recorded-aircraft.json";

/** A raw dump1090 aircraft.json entry (subset of fields we care about). */
export interface RawAircraft {
  hex: string;
  flight?: string | null;
  alt_baro?: number | "ground" | null;
  alt_geom?: number | null;
  lat?: number | null;
  lon?: number | null;
  gs?: number | null;
  track?: number | null;
  baro_rate?: number | null;
  geom_rate?: number | null;
  category?: string | null;
  seen?: number;
  seen_pos?: number | null;
  nav_altitude_mcp?: number | null;
}

export interface RawFrame {
  now: number;
  messages?: number;
  aircraft: RawAircraft[];
}

interface RecordedSeries {
  home: { lat: number; lon: number };
  frameIntervalSeconds: number;
  frames: RawFrame[];
}

const series = recorded as unknown as RecordedSeries;

/** The observer home position the series was authored around (demo GPS origin). */
export const DEMO_HOME = series.home;

/** Convert a raw dump1090 entry to the slim DTO, handling the known gotchas. */
export function toDto(raw: RawAircraft, src = "adsb"): AircraftDto {
  const ground = raw.alt_baro === "ground";
  const altBaro = typeof raw.alt_baro === "number" ? raw.alt_baro : null;
  const alt = altBaro ?? (typeof raw.alt_geom === "number" ? raw.alt_geom : null);
  const fl = ground ? 0 : altBaro != null ? Math.round(altBaro / 100) : null;
  const vr =
    typeof raw.baro_rate === "number"
      ? raw.baro_rate
      : typeof raw.geom_rate === "number"
        ? raw.geom_rate
        : null;

  return {
    hex: raw.hex.toLowerCase(),
    flight: raw.flight ? raw.flight.trim() || null : null,
    fl,
    lat: typeof raw.lat === "number" ? raw.lat : null,
    lon: typeof raw.lon === "number" ? raw.lon : null,
    alt: ground ? 0 : alt,
    gs: typeof raw.gs === "number" ? raw.gs : null,
    trk: typeof raw.track === "number" ? raw.track : null,
    vr,
    seen: typeof raw.seen === "number" ? raw.seen : 0,
    cat: raw.category ?? null,
    src,
  };
}

/** Convert a whole raw frame to a DTO list. */
export function frameToDtos(frame: RawFrame): AircraftDto[] {
  return frame.aircraft.map((a) => toDto(a));
}

export interface MockFeedHandle {
  stop: () => void;
}

export interface MockFeedOptions {
  /** Called with each 1 Hz snapshot of DTOs. */
  onSnapshot: (aircraft: AircraftDto[]) => void;
  /** Replay interval override in ms (defaults to the series cadence). */
  intervalMs?: number;
  /** Injectable timers for tests. */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

/**
 * Start replaying the recorded series, looping when it reaches the end. Emits the
 * first frame synchronously so the UI has data immediately, then advances on a timer.
 */
export function startMockFeed(options: MockFeedOptions): MockFeedHandle {
  const setIntervalFn = options.setIntervalImpl ?? setInterval;
  const clearIntervalFn = options.clearIntervalImpl ?? clearInterval;
  const intervalMs = options.intervalMs ?? series.frameIntervalSeconds * 1000;
  const frames = series.frames;

  let idx = 0;
  const emit = () => {
    options.onSnapshot(frameToDtos(frames[idx]));
    idx = (idx + 1) % frames.length;
  };

  emit(); // immediate first frame
  const timer = setIntervalFn(emit, intervalMs);
  return { stop: () => clearIntervalFn(timer) };
}

/** All frames as DTO lists (useful for tests / non-timer consumers). */
export function allFramesAsDtos(): AircraftDto[][] {
  return series.frames.map(frameToDtos);
}
