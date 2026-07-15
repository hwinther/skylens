/**
 * Auth session state. Deliberately tiny: the tokens themselves live in the secure
 * token store (src/auth/tokenStore); this store only tracks the reactive session
 * status and the mock-auth toggle so screens can re-render on sign-in/out.
 */

import { create } from "zustand";

// Same opt-in override settingsStore uses: the hosted web build is baked with
// EXPO_PUBLIC_FORCE_LIVE=1 so it boots into the real OIDC flow even under `expo start`.
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
  // Mock auth is a dev convenience only (Expo Go / metro, where __DEV__ is true).
  // Release builds — standalone Android/iOS and the static web export — must boot
  // into the real OIDC flow: they don't inherit build-time env, so keying this off
  // FORCE_LIVE alone left Play-track installs preselected on mock.
  mockMode: __DEV__ && !forceLive,
  setStatus: (status) => set({ status }),
  setMockMode: (mockMode) => set({ mockMode }),
}));
