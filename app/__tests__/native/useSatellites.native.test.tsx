/**
 * useSatellites: fetches the OMM snapshot (only while the API may be called), propagates it at 1 Hz
 * and returns what is above the elevation mask in the enabled groups. A failed fetch falls back to
 * empty and retries on the escalating schedule (retryDelayMs, unit-tested on its own); returning to
 * the foreground refetches. Uses the real ApiClient against a routed fetch and the real SGP4 path.
 */
import { act, renderHook } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";
import { ApiClient } from "@/api/client";
import { useSatellites, retryDelayMs, type UseSatellitesOptions } from "@/components/useSatellites";
import type { SatGroup } from "@/ar/satellites";
import type { SatelliteDto } from "@/api/types";
import { useAuthStore } from "@/state/authStore";
import { backendJson, routeFetch } from "./fixtures";

/** Verbatim ISS OMM (same fixture as __tests__/satellites.test.ts). */
const ISS: SatelliteDto = {
  noradId: 25544,
  name: "ISS (ZARYA)",
  group: "stations",
  omm: {
    OBJECT_NAME: "ISS (ZARYA)",
    OBJECT_ID: "1998-067A",
    EPOCH: "2026-07-11T07:33:23.712192",
    MEAN_MOTION: 15.48978902,
    ECCENTRICITY: 0.00066885,
    INCLINATION: 51.6302,
    RA_OF_ASC_NODE: 180.6822,
    ARG_OF_PERICENTER: 282.4935,
    MEAN_ANOMALY: 77.5305,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: "U",
    NORAD_CAT_ID: 25544,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 57549,
    BSTAR: 0.00010843416,
    MEAN_MOTION_DOT: 5.525e-5,
    MEAN_MOTION_DDOT: 0,
  } as unknown as SatelliteDto["omm"],
};
const OBSERVER = { lat: 59.9, lon: 10.75 };

// A real pass ~14 h after the epoch: the ISS is ~20° up in the south (pinned in satellites.test.ts).
const PASS_TIME = new Date("2026-07-11T21:52:23.712Z");

const STATIONS = new Set<SatGroup>(["stations"]);

describe("useSatellites", () => {
  let options: UseSatellitesOptions;

  beforeEach(() => {
    jest.useFakeTimers();
    options = {
      client: new ApiClient({ baseUrl: "http://api.test" }),
      observer: OBSERVER,
      enabled: true,
      groups: STATIONS,
      elevationMaskDeg: 5,
      now: () => PASS_TIME,
    };
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  async function renderSats(over: Partial<UseSatellitesOptions> = {}) {
    const hook = await renderHook((p: UseSatellitesOptions) => useSatellites(p), {
      initialProps: { ...options, ...over },
    });
    await act(async () => {});
    return hook;
  }

  const satsOk = () => backendJson({ tleAgeSeconds: 3600, satellites: [ISS] });

  it("fetches nothing while signed out behind auth, and loads once the API may be called", async () => {
    const requested = routeFetch({ "/api/satellites": satsOk });
    const { result } = await renderSats();
    expect(requested).toEqual([]);
    expect(result.current.status).toBe("unavailable");
    expect(result.current.visible).toEqual([]);

    await act(async () => useAuthStore.setState({ authRequired: false }));
    await act(async () => {});

    expect(requested).toEqual(["/api/satellites"]);
    expect(result.current.status).toBe("ok");
    expect(result.current.tleAgeSeconds).toBe(3600);
    expect(result.current.visible.map((v) => v.noradId)).toEqual([25544]);
    expect(result.current.byNoradId.get(25544)?.elevationDeg).toBeGreaterThan(15);
    expect(result.current.satellitesSampledAt).toBe(PASS_TIME.getTime());
  });

  it("drops satellites in a disabled group or below the mask", async () => {
    useAuthStore.setState({ authRequired: false });
    routeFetch({ "/api/satellites": satsOk });
    const { result, rerender } = await renderSats();
    expect(result.current.visible).toHaveLength(1);

    await rerender({ ...options, groups: new Set<SatGroup>(["weather"]) });
    await act(async () => jest.advanceTimersByTime(1_000));
    expect(result.current.visible).toEqual([]);

    await rerender({ ...options, elevationMaskDeg: 89 });
    await act(async () => jest.advanceTimersByTime(1_000));
    expect(result.current.visible).toEqual([]);
  });

  it("retries a failed fetch on the backoff schedule", async () => {
    useAuthStore.setState({ authRequired: false });
    let fail = true;
    const requested = routeFetch({
      "/api/satellites": () => (fail ? backendJson({ error: "no snapshot yet" }, 503) : satsOk()),
    });
    const { result } = await renderSats();
    expect(result.current.status).toBe("unavailable");

    fail = false;
    await act(async () => jest.advanceTimersByTime(retryDelayMs(0) - 1));
    expect(requested.filter((p) => p === "/api/satellites")).toHaveLength(1);
    await act(async () => jest.advanceTimersByTime(1));
    await act(async () => {});

    expect(requested.filter((p) => p === "/api/satellites")).toHaveLength(2);
    expect(result.current.status).toBe("ok");
  });

  it("refetches when the app comes back to the foreground", async () => {
    useAuthStore.setState({ authRequired: false });
    const listeners: ((s: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      listeners.push(listener as (s: AppStateStatus) => void);
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    const requested = routeFetch({ "/api/satellites": satsOk });
    await renderSats();

    await act(async () => listeners.forEach((l) => l("background")));
    expect(requested.filter((p) => p === "/api/satellites")).toHaveLength(1);
    await act(async () => listeners.forEach((l) => l("active")));
    expect(requested.filter((p) => p === "/api/satellites")).toHaveLength(2);
  });

  it("idles with the layer switched off", async () => {
    useAuthStore.setState({ authRequired: false });
    const requested = routeFetch({ "/api/satellites": satsOk });
    const { result } = await renderSats({ enabled: false });
    expect(requested).toEqual([]);
    expect(result.current.status).toBe("unavailable");
  });
});
