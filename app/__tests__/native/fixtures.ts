/**
 * Test data for the native component tests, seeded through the real zustand stores (as the store
 * tests do). Positions sit a few km from the demo home (59.9, 10.75), which is the observer while
 * demo mode is on.
 */
import type { AircraftDto } from "@/api/types";
import { useAircraftStore } from "@/state/aircraftStore";
import { useMapFocusStore } from "@/state/mapFocusStore";
import { useSatelliteTrackStore } from "@/state/satelliteTrackStore";
import { useSettingsStore } from "@/state/settingsStore";
import { useVesselStore } from "@/state/vesselStore";

export function aircraft(hex: string, over: Partial<AircraftDto> = {}): AircraftDto {
  return { hex, lat: 59.95, lon: 10.8, fl: 120, gs: 280, trk: 90, ...over };
}

/** Clean slate: no traffic, no focus or track, demo mode with only the traffic layers on. */
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
  });
}

export function seedAircraft(list: AircraftDto[]) {
  useAircraftStore.getState().setSnapshot(list);
}
