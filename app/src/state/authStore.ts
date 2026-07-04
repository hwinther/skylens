/**
 * Auth session state. Deliberately tiny: the tokens themselves live in the secure
 * token store (src/auth/tokenStore); this store only tracks the reactive session
 * status and the mock-auth toggle so screens can re-render on sign-in/out.
 */

import { create } from "zustand";

// Same opt-in override settingsStore uses: the hosted web build is baked with
// EXPO_PUBLIC_FORCE_LIVE=1 so it boots into the real OIDC flow, while native/Expo-Go
// dev (env unset) still defaults to mock auth until a custom-scheme dev build exists.
// The live SignalR feed is gated on demoMode, not auth, so mock vs live sign-in never
// affects the (empty-bearer) live connect used by the E2E and preview envs.
const forceLive =
  process.env.EXPO_PUBLIC_FORCE_LIVE === "1" || process.env.EXPO_PUBLIC_FORCE_LIVE === "true";

export type AuthStatus =
  | "unknown" // before hydrate() has run
  | "unauthenticated"
  | "authenticating"
  | "authenticated";

interface AuthState {
  status: AuthStatus;
  /** When true, sign-in skips OIDC and mints a fake token (Expo Go / demo). */
  mockMode: boolean;
  setStatus: (status: AuthStatus) => void;
  setMockMode: (mockMode: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: "unknown",
  // Mock auth by default (Expo Go / native dev before the custom-scheme dev build),
  // but the FORCE_LIVE web build boots straight into the real OIDC flow.
  mockMode: !forceLive,
  setStatus: (status) => set({ status }),
  setMockMode: (mockMode) => set({ mockMode }),
}));
