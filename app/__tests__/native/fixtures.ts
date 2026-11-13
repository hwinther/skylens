/**
 * Test data for the native component tests, seeded through the real zustand stores (as the store
 * tests do). Positions sit a few km from the demo home (59.9, 10.75), which is the observer while
 * demo mode is on.
 */
import type { AircraftDto, SatelliteDto } from "@/api/types";
import { useAircraftStore } from "@/state/aircraftStore";
import { useMapFocusStore } from "@/state/mapFocusStore";
import { useSatelliteTrackStore } from "@/state/satelliteTrackStore";
import { useSettingsStore } from "@/state/settingsStore";
import { useVesselStore } from "@/state/vesselStore";

export function aircraft(hex: string, over: Partial<AircraftDto> = {}): AircraftDto {
  return { hex, lat: 59.95, lon: 10.8, fl: 120, gs: 280, trk: 90, ...over };
}

/** Clean slate: no traffic, no focus or track, demo mode with only the traffic layers on, List unfiltered. */
export function resetStores() {
  useAircraftStore.setState({ byHex: {}, lastSnapshotAt: 0, feedStatus: null });
  useVesselStore.setState({ byMmsi: {}, lastSnapshotAt: 0 });
  useMapFocusStore.setState({ focus: null, seq: 0, following: false });
  useSatelliteTrackStore.setState({ trackedNoradId: null });
  useSettingsStore.setState({
    demoMode: true,
    showShips: true,
    showAirports: false,
    showPorts: false,
    showSatellites: false,
    showPlanets: false,
    showRadioSky: false,
    showSkyEvents: false,
    showFishingZones: false,
    showLostGear: false,
    listHiddenKinds: [],
    listCollapsedSections: [],
  });
}

export function seedAircraft(list: AircraftDto[]) {
  useAircraftStore.getState().setSnapshot(list);
}

/** A response from the backend (it carries the X-Skylens-Api marker), with a JSON body. */
export function backendJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Skylens-Api": "1" },
  });
}

/**
 * Route fetch by URL path: each entry answers one path (the query string is ignored); anything else
 * rejects like the default in setup.ts. Returns the paths requested so far.
 */
export function routeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const requested: string[] = [];
  jest.mocked(globalThis.fetch).mockImplementation((input) => {
    const path = new URL(String(input)).pathname;
    requested.push(path);
    const answer = routes[path];
    return answer
      ? Promise.resolve(answer())
      : Promise.reject(new Error(`unexpected network call in a component test: ${String(input)}`));
  });
  return requested;
}

/** Verbatim ISS OMM (same fixture as __tests__/satellites.test.ts). */
export const ISS_DTO: SatelliteDto = {
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

/** A real ISS pass over the demo home: ~20° up in the south at this instant (pinned in satellites.test.ts). */
export const ISS_PASS_TIME = new Date("2026-07-11T21:52:23.712Z");
