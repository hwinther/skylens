/**
 * The live observer position, shared by every screen: baked EXPO_PUBLIC_HOME_* coordinates when the
 * build has them, else the device/browser geolocation fix. Written once by the root layout (which
 * owns the only useObserverLocation call, so there is one permission prompt and one fix), read via
 * useObserver / useLiveObserver. Null until the first fix, and in demo mode.
 */

import { create } from "zustand";
import type { HomeLocation } from "@/api/config";

interface ObserverState {
  position: HomeLocation | null;
  setPosition: (position: HomeLocation | null) => void;
}

export const useObserverStore = create<ObserverState>((set) => ({
  position: null,
  setPosition: (position) => set({ position }),
}));
