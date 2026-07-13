/**
 * User settings: AR calibration + demo toggle. Persisted to expo-secure-store via
 * zustand's persist middleware so calibration survives restarts.
 *
 * The persist storage adapter wraps SecureStore in the StateStorage interface
 * zustand expects. SecureStore is only available on native; under jest/web the
 * adapter degrades to an in-memory map so tests and web bundling don't crash.
 */

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import * as SecureStore from "expo-secure-store";
import { DEFAULT_HFOV_DEG } from "@/ar/projection";
import { DEFAULT_ELEVATION_MASK_DEG } from "@/ar/satellites";

interface SettingsState {
  /** Manual azimuth trim in degrees, applied on top of declination. */
  azimuthTrimDeg: number;
  /** Horizontal field of view in degrees for the pinhole projection. */
  hFovDeg: number;
  /** Subscription radius in km sent to the hub's Subscribe(). */
  radiusKm: number;
  /** Demo mode: replay recorded feed + drag-to-look instead of camera/sensors. */
  demoMode: boolean;
  /** Radar outer-ring range in km; `0` = auto-scale to the farthest blip (default). */
  radarRangeKm: number;
  /** Show AIS ships on the map/radar/list. */
  showShips: boolean;
  /** Show AIS aids to navigation (lighthouses, beacons, buoys). */
  showAton: boolean;
  /** Draw the orbital (satellite) pass in the AR overlay. */
  showSatellites: boolean;
  /** Include the crewed "stations" + "amateur" satellite groups. */
  satAmateurStations: boolean;
  /** Include the "weather" satellite group. */
  satWeather: boolean;
  /** Include the "gnss" satellite group (dense nav constellations). */
  satGnss: boolean;
  /** Elevation mask (deg): satellites lower than this above the horizon are hidden. */
  satElevationMaskDeg: number;
  setAzimuthTrim: (deg: number) => void;
  setHFov: (deg: number) => void;
  setRadiusKm: (km: number) => void;
  setRadarRangeKm: (km: number) => void;
  setDemoMode: (on: boolean) => void;
  setShowShips: (on: boolean) => void;
  setShowAton: (on: boolean) => void;
  setShowSatellites: (on: boolean) => void;
  setSatAmateurStations: (on: boolean) => void;
  setSatWeather: (on: boolean) => void;
  setSatGnss: (on: boolean) => void;
  setSatElevationMaskDeg: (deg: number) => void;
}

// Opt-in override so the web build / Playwright E2E can boot straight into live mode (which talks to
// the backend) instead of the default demo replay. No effect unless the env var is set.
const forceLive =
  process.env.EXPO_PUBLIC_FORCE_LIVE === "1" || process.env.EXPO_PUBLIC_FORCE_LIVE === "true";

const memoryFallback = new Map<string, string>();

const secureStorage: StateStorage = {
  getItem: async (name) => {
    try {
      return (await SecureStore.getItemAsync(name)) ?? null;
    } catch {
      return memoryFallback.get(name) ?? null;
    }
  },
  setItem: async (name, value) => {
    try {
      await SecureStore.setItemAsync(name, value);
    } catch {
      memoryFallback.set(name, value);
    }
  },
  removeItem: async (name) => {
    try {
      await SecureStore.deleteItemAsync(name);
    } catch {
      memoryFallback.delete(name);
    }
  },
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      azimuthTrimDeg: 0,
      hFovDeg: DEFAULT_HFOV_DEG,
      radiusKm: 60,
      radarRangeKm: 0,
      demoMode: !forceLive,
      showShips: true,
      showAton: true,
      showSatellites: true,
      satAmateurStations: true,
      satWeather: true,
      satGnss: true,
      satElevationMaskDeg: DEFAULT_ELEVATION_MASK_DEG,
      setAzimuthTrim: (azimuthTrimDeg) => set({ azimuthTrimDeg }),
      setHFov: (hFovDeg) => set({ hFovDeg }),
      setRadiusKm: (radiusKm) => set({ radiusKm }),
      setRadarRangeKm: (radarRangeKm) => set({ radarRangeKm }),
      setDemoMode: (demoMode) => set({ demoMode }),
      setShowShips: (showShips) => set({ showShips }),
      setShowAton: (showAton) => set({ showAton }),
      setShowSatellites: (showSatellites) => set({ showSatellites }),
      setSatAmateurStations: (satAmateurStations) => set({ satAmateurStations }),
      setSatWeather: (satWeather) => set({ satWeather }),
      setSatGnss: (satGnss) => set({ satGnss }),
      setSatElevationMaskDeg: (satElevationMaskDeg) => set({ satElevationMaskDeg }),
    }),
    {
      name: "skylens.settings.v1",
      storage: createJSONStorage(() => secureStorage),
    },
  ),
);
