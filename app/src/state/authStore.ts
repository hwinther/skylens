/**
 * Auth session state. Deliberately tiny: the tokens themselves live in the token store
 * (src/auth/tokenStore: SecureStore on native, localStorage on web); this store tracks the
 * reactive session status, whether the backend requires a sign-in at all (the probe in the root
 * layout, see src/auth/access), the last sign-in error, and the mock-auth toggle, so screens can
 * re-render on sign-in/out.
 *
 * useApiAllowed() is the gate every API caller checks: no API calls while the backend wants a
 * sign-in and there is none (and while that is still unknown).
 */

import { create } from "zustand";
import { accessAllowsApi, apiAccess, type ApiAccess } from "@/auth/access";

// Same opt-in override settingsStore uses: the hosted web build is baked with
// EXPO_PUBLIC_FORCE_LIVE=1 so it boots into the real OIDC flow even under `expo start`.
const forceLive =
  process.env.EXPO_PUBLIC_FORCE_LIVE === "1" || process.env.EXPO_PUBLIC_FORCE_LIVE === "true";

export type AuthStatus =
  | "unknown" // before hydrate() has run
  | "unauthenticated"
  | "authenticating"
  | "authenticated";

interface AuthState {
  status: AuthStatus;
  /**
   * Whether the backend requires a sign-in: false under DevAuth (anonymous /api/me → 200), true
   * behind real auth (401), null until the startup probe has an answer.
   */
  authRequired: boolean | null;
  /** User-facing reason the last sign-in attempt failed; null when there is none. */
  lastError: string | null;
  /** When true, sign-in skips OIDC and mints a fake token (Expo Go / demo). */
  mockMode: boolean;
  setStatus: (status: AuthStatus) => void;
  setAuthRequired: (authRequired: boolean | null) => void;
  setLastError: (lastError: string | null) => void;
  setMockMode: (mockMode: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: "unknown",
  authRequired: null,
  lastError: null,
  // Mock auth is a dev convenience only (Expo Go / metro, where __DEV__ is true).
  // Release builds — standalone Android/iOS and the static web export — must boot
  // into the real OIDC flow: they don't inherit build-time env, so keying this off
  // FORCE_LIVE alone left Play-track installs preselected on mock.
  mockMode: __DEV__ && !forceLive,
  setStatus: (status) => set({ status }),
  setAuthRequired: (authRequired) => set({ authRequired }),
  setLastError: (lastError) => set({ lastError }),
  setMockMode: (mockMode) => set({ mockMode }),
}));

/** The API access state right now (see src/auth/access). */
export function useApiAccess(): ApiAccess {
  return useAuthStore((s) => apiAccess(s.status, s.authRequired));
}

/** True while the app may call the API: the backend is open (DevAuth) or there is a session. */
export function useApiAllowed(): boolean {
  return useAuthStore((s) => accessAllowsApi(apiAccess(s.status, s.authRequired)));
}

/** Non-hook form of useApiAllowed for callbacks and imperative code. */
export function isApiAllowed(): boolean {
  const s = useAuthStore.getState();
  return accessAllowsApi(apiAccess(s.status, s.authRequired));
}
