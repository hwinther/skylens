/**
 * Does the backend want a sign-in, and may the app call the API right now?
 *
 * Production validates a bearer on everything under /api and /hubs/aircraft, but local dev, the
 * e2e suite and the preview deployments can run the backend with DevAuth, where every request is
 * already authenticated and the app never signs in. So instead of assuming, the root layout probes
 * once: an anonymous GET /api/me answers 200 under DevAuth and 401 behind real auth.
 *
 * Pure TS (no react-native imports) so it is unit-testable.
 */

import type { AuthStatus } from "@/state/authStore";

/**
 * GET {baseUrl}/api/me with NO Authorization header. Deliberately a raw fetch, not ApiClient: an
 * expected 401 here must not raise the API issue banner or be reported to /api/client-log.
 *
 * @returns false when the backend answers anonymously (200), true when it wants a sign-in (401),
 *   null when the answer says neither (network error, 5xx, an edge block) — try again later.
 */
export async function probeAuthRequired(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<boolean | null> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/me`, {
      headers: { Accept: "application/json" },
    });
    if (res.status === 200) return false;
    if (res.status === 401) return true;
    return null;
  } catch {
    return null;
  }
}

/**
 * - `open`: the backend needs no sign-in (DevAuth); call the API freely.
 * - `signed-in`: there is a session; call the API with its token.
 * - `sign-in-required`: the backend wants a sign-in and there is none; make no API calls.
 * - `unknown`: still finding out (session not hydrated, or the probe has no answer yet).
 */
export type ApiAccess = "unknown" | "open" | "signed-in" | "sign-in-required";

export function apiAccess(status: AuthStatus, authRequired: boolean | null): ApiAccess {
  if (status === "authenticated") return "signed-in";
  if (authRequired === false) return "open";
  if (authRequired === true && (status === "unauthenticated" || status === "authenticating")) {
    return "sign-in-required";
  }
  return "unknown";
}

/** True when the app may call the API (any endpoint other than the anonymous ones). */
export function accessAllowsApi(access: ApiAccess): boolean {
  return access === "open" || access === "signed-in";
}
