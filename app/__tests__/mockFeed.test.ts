import {
  allFramesAsDtos,
  DEMO_HOME,
  frameToDtos,
  startMockFeed,
  toDto,
  type RawAircraft,
} from "@/mock/mockFeed";
import { deadReckon, KNOTS_TO_MPS } from "@/ar/smoothing";
import { geodeticToEnu } from "@/ar/geo";
import type { AircraftDto } from "@/api/types";

describe("toDto — dump1090 gotchas", () => {
  it("trims space-padded flight and lowercases hex", () => {
    const raw: RawAircraft = { hex: "4CA7B3", flight: "SAS1782 ", seen: 0.1 };
    const dto = toDto(raw);
    expect(dto.hex).toBe("4ca7b3");
    expect(dto.flight).toBe("SAS1782");
  });

  it("maps alt_baro 'ground' to alt 0, fl 0", () => {
    const raw: RawAircraft = { hex: "abc", alt_baro: "ground", seen: 0.5 };
    const dto = toDto(raw);
    expect(dto.alt).toBe(0);
    expect(dto.fl).toBe(0);
  });

  it("computes flight level from alt_baro", () => {
    const raw: RawAircraft = { hex: "abc", alt_baro: 34000, seen: 0.1 };
    expect(toDto(raw).fl).toBe(340);
  });

  it("keeps position-less aircraft with null lat/lon", () => {
    const raw: RawAircraft = { hex: "3c6dd2", flight: "BER22H", seen: 0.3 };
    const dto = toDto(raw);
    expect(dto.lat).toBeNull();
    expect(dto.lon).toBeNull();
  });

  it("falls back to geom_rate for vertical rate", () => {
    const raw: RawAircraft = { hex: "abc", geom_rate: -800, seen: 0.1 };
    expect(toDto(raw).vr).toBe(-800);
  });

  it("carries float seen through", () => {
    const raw: RawAircraft = { hex: "abc", seen: 0.2 };
    expect(toDto(raw).seen).toBeCloseTo(0.2, 6);
  });
});

describe("recorded series", () => {
  it("has a plausible frame count and consistent motion", () => {
    const frames = allFramesAsDtos();
    expect(frames.length).toBeGreaterThanOrEqual(10);
    expect(frames.length).toBeLessThanOrEqual(20);

    // Track SAS1782 (4ca7b3) across the series: its measured step should match
    // its advertised gs/track (dead-reckoning distance ≈ gs·dt).
    const first = frames[0].find((a) => a.hex === "4ca7b3") as AircraftDto;
    const last = frames[frames.length - 1].find((a) => a.hex === "4ca7b3") as AircraftDto;
    const dtSeconds = frames.length - 1; // 1 Hz cadence

    const enu = geodeticToEnu(
      { lat: first.lat!, lon: first.lon!, alt: 0 },
      { lat: last.lat!, lon: last.lon!, alt: 0 },
    );
    const traveled = Math.hypot(enu.e, enu.n);
    const expected = first.gs! * KNOTS_TO_MPS * dtSeconds;
    // Within 2% — small rounding from the 5-decimal lat/lon in the JSON.
    expect(traveled).toBeGreaterThan(expected * 0.98);
    expect(traveled).toBeLessThan(expected * 1.02);
  });

  it("dead-reckoning a frame forward matches the next frame", () => {
    const frames = allFramesAsDtos();
    const ac0 = frames[0].find((a) => a.hex === "4ca7b3") as AircraftDto;
    const ac1 = frames[1].find((a) => a.hex === "4ca7b3") as AircraftDto;
    const dr = deadReckon(
      { lat: ac0.lat!, lon: ac0.lon!, alt: 0, gs: ac0.gs!, trk: ac0.trk!, vr: 0 },
      1,
    );
    expect(dr.lat).toBeCloseTo(ac1.lat!, 3);
    expect(dr.lon).toBeCloseTo(ac1.lon!, 3);
  });

  it("exposes the demo home position", () => {
    expect(DEMO_HOME.lat).toBeCloseTo(59.9, 1);
    expect(DEMO_HOME.lon).toBeCloseTo(10.75, 2);
  });
});

describe("startMockFeed", () => {
  it("emits the first frame immediately and advances on the timer", () => {
    jest.useFakeTimers();
    const snapshots: AircraftDto[][] = [];
    const handle = startMockFeed({
      onSnapshot: (a) => snapshots.push(a),
      intervalMs: 1000,
    });
    expect(snapshots).toHaveLength(1); // immediate first frame
    jest.advanceTimersByTime(3000);
    expect(snapshots.length).toBe(4); // 1 + 3 ticks
    handle.stop();
    jest.advanceTimersByTime(5000);
    expect(snapshots.length).toBe(4); // stopped
    jest.useRealTimers();
  });

  it("loops back to the start after the last frame", () => {
    jest.useFakeTimers();
    const snapshots: AircraftDto[][] = [];
    const total = allFramesAsDtos().length;
    const handle = startMockFeed({ onSnapshot: (a) => snapshots.push(a), intervalMs: 100 });
    jest.advanceTimersByTime(100 * (total + 1));
    // After wrapping, the (total+1)-th emission equals frame index 1 again.
    expect(snapshots.length).toBe(total + 2);
    handle.stop();
    jest.useRealTimers();
  });
});

describe("frameToDtos", () => {
  it("maps a whole frame", () => {
    const dtos = frameToDtos({ now: 0, aircraft: [{ hex: "a", seen: 0.1 }] });
    expect(dtos).toHaveLength(1);
    expect(dtos[0].hex).toBe("a");
  });
});
