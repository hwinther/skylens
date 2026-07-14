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
  /** Draw a short predicted-track (course/heading) leader ahead of moving aircraft & ships. */
  showCourseVectors: boolean;
  /** Show airports as reference points (markers + runways on the map, diamonds on the radar). */
  showAirports: boolean;
  /** Include the smaller fields (small airports / heliports / seaplane bases); large + medium always show. */
  showSmallAirfields: boolean;
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
  /** Draw the Solar-System bodies (Sun, Moon, planets) in the AR sky pass + Sky list. */
  showPlanets: boolean;
  /** Draw the faint ecliptic arc across the AR sky (the Sun's path / the plane the planets hug). */
  showEcliptic: boolean;
  /** Draw the fixed radio-astronomy sources (Sgr A*, Cas A, Cyg A, Tau A) in the AR sky + Radio list. */
  showRadioSky: boolean;
  /** Draw fishing-regulation zones (cod boundaries / forbidden / zero areas) on the geographic map. */
  showFishingZones: boolean;
  /** Draw reported lost/ghost fishing-gear points on the geographic map. */
  showLostGear: boolean;
  /** First-run onboarding completed (or skipped). Gates the one-time intro flow. */
  onboarded: boolean;
  /** True once persisted settings have finished rehydrating — the onboarding gate waits for this so a
   *  returning user never flashes the intro. Transient; its persisted value is irrelevant (the initial
   *  value is always false until hydration completes). */
  _hydrated: boolean;
  setAzimuthTrim: (deg: number) => void;
  setHFov: (deg: number) => void;
  setRadiusKm: (km: number) => void;
  setRadarRangeKm: (km: number) => void;
  setDemoMode: (on: boolean) => void;
  setShowShips: (on: boolean) => void;
  setShowAton: (on: boolean) => void;
  setShowCourseVectors: (on: boolean) => void;
  setShowAirports: (on: boolean) => void;
  setShowSmallAirfields: (on: boolean) => void;
  setShowSatellites: (on: boolean) => void;
  setSatAmateurStations: (on: boolean) => void;
  setSatWeather: (on: boolean) => void;
  setSatGnss: (on: boolean) => void;
  setSatElevationMaskDeg: (deg: number) => void;
  setShowPlanets: (on: boolean) => void;
  setShowEcliptic: (on: boolean) => void;
  setShowRadioSky: (on: boolean) => void;
  setShowFishingZones: (on: boolean) => void;
  setShowLostGear: (on: boolean) => void;
  setOnboarded: (on: boolean) => void;
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
      showCourseVectors: true,
      // Airports are baked-in reference data, so they're on by default; the smaller fields declutter with
      // a second toggle (large + medium airports always show while showAirports is on).
      showAirports: true,
      showSmallAirfields: true,
      showSatellites: true,
      satAmateurStations: true,
      satWeather: true,
      satGnss: true,
      satElevationMaskDeg: DEFAULT_ELEVATION_MASK_DEG,
      // Sun/Moon/planets are on by default (a free, always-available sky layer); the ecliptic arc is a
      // subtler power-user overlay, so it stays opt-in.
      showPlanets: true,
      showEcliptic: false,
      // Radio-astronomy targets are a niche SDR power-user layer (invisible to the eye), so opt-in.
      showRadioSky: false,
      // Fishing overlays are opt-in — they only make sense over the fjord/coast map view, so default off.
      showFishingZones: false,
      showLostGear: false,
      onboarded: false,
      _hydrated: false,
      setAzimuthTrim: (azimuthTrimDeg) => set({ azimuthTrimDeg }),
      setHFov: (hFovDeg) => set({ hFovDeg }),
      setRadiusKm: (radiusKm) => set({ radiusKm }),
      setRadarRangeKm: (radarRangeKm) => set({ radarRangeKm }),
      setDemoMode: (demoMode) => set({ demoMode }),
      setShowShips: (showShips) => set({ showShips }),
      setShowAton: (showAton) => set({ showAton }),
      setShowCourseVectors: (showCourseVectors) => set({ showCourseVectors }),
      setShowAirports: (showAirports) => set({ showAirports }),
      setShowSmallAirfields: (showSmallAirfields) => set({ showSmallAirfields }),
      setShowSatellites: (showSatellites) => set({ showSatellites }),
      setSatAmateurStations: (satAmateurStations) => set({ satAmateurStations }),
      setSatWeather: (satWeather) => set({ satWeather }),
      setSatGnss: (satGnss) => set({ satGnss }),
      setSatElevationMaskDeg: (satElevationMaskDeg) => set({ satElevationMaskDeg }),
      setShowFishingZones: (showFishingZones) => set({ showFishingZones }),
      setShowLostGear: (showLostGear) => set({ showLostGear }),
      setOnboarded: (onboarded) => set({ onboarded }),
      setShowPlanets: (showPlanets) => set({ showPlanets }),
      setShowEcliptic: (showEcliptic) => set({ showEcliptic }),
      setShowRadioSky: (showRadioSky) => set({ showRadioSky }),
    }),
    {
      name: "skylens.settings.v1",
      storage: createJSONStorage(() => secureStorage),
      // Flip the hydration flag once persisted settings load, so the onboarding gate can wait for it
      // and never flash the intro at a returning user. Fires even on a fresh install (empty storage).
      onRehydrateStorage: () => () => useSettingsStore.setState({ _hydrated: true }),
    },
  ),
);
