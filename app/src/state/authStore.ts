/**
 * Auth session state. Deliberately tiny: the tokens themselves live in the secure
 * token store (src/auth/tokenStore); this store only tracks the reactive session
 * status and the mock-auth toggle so screens can re-render on sign-in/out.
 */

import { create } from "zustand";

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
  // Default to mock mode until the custom-scheme dev build exists (plan Phase 3).
  mockMode: true,
  setStatus: (status) => set({ status }),
  setMockMode: (mockMode) => set({ mockMode }),
}));
