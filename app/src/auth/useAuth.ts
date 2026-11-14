/**
 * expo-auth-session PKCE (S256) sign-in against Authelia, plus token persistence
 * and refresh. Exposes a hook the sign-in screen and app root use.
 *
 * Flow:
 *  - useOidcDiscovery loads the OIDC discovery document from auth.wsh.no.
 *  - useFreshAuthRequest prepares a PKCE (S256) request for the `skylens` public client, with a new
 *    `state` and code verifier for EVERY attempt (expo's useAuthRequest builds one request per mount
 *    and reuses its URL, state and verifier on every retry). The URL is built ahead of the press, so
 *    on web the popup still opens straight from the user gesture.
 *  - promptAsync opens the IdP: a popup on web, a Custom Tab on Android that comes back through the
 *    `skylens://oauth` redirect. expo-auth-session turns a redirect whose `state` doesn't match into
 *    an error result (`state_mismatch`).
 *  - On success we exchange the code for tokens (exchangeCodeAsync), persist them,
 *    and mark the session authenticated. Any failure (popup blocked, no browser, IdP error, failed
 *    exchange, network down) returns to "unauthenticated" with a message in authStore.lastError
 *    (worded in ./errors). Closing the browser is not an error: it just returns to signed out.
 *  - Refresh lives in ./refresh (hook-free) so the hub and the root layout can use it too.
 *
 * Mock mode (dev-only default, see authStore) short-circuits all of this and mints
 * a fake token so the app is usable in Expo Go without touching the IdP.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import {
  OIDC_AUDIENCE,
  OIDC_CLIENT_ID,
  OIDC_ISSUER,
  OIDC_REDIRECT_PATH,
  OIDC_SCHEME,
  OIDC_SCOPES,
} from "./config";
import { IDP_UNREACHABLE_MESSAGE, signInErrorMessage } from "./errors";
import { mintMockToken } from "./mockAuth";
import { ensureFreshAccessToken, toStored } from "./refresh";
import { clearTokens, setTokens } from "./tokenStore";
import { useAuthStore } from "@/state/authStore";

// Required so the OAuth popup dismisses cleanly on native.
WebBrowser.maybeCompleteAuthSession();

export const OIDC_REDIRECT_URI = AuthSession.makeRedirectUri({
  scheme: OIDC_SCHEME,
  path: OIDC_REDIRECT_PATH,
});

const AUTH_REQUEST_CONFIG: AuthSession.AuthRequestConfig = {
  clientId: OIDC_CLIENT_ID,
  scopes: OIDC_SCOPES,
  redirectUri: OIDC_REDIRECT_URI,
  usePKCE: true,
  // Ask Authelia to include the API audience in the access token.
  extraParams: { audience: OIDC_AUDIENCE },
};

/**
 * True from the moment a sign-in opens the IdP until it has settled (code exchange included). The
 * native /oauth route reads it to tell the redirect of a sign-in in progress from one that nothing
 * is waiting for (Android restarted the app while the browser was open).
 */
let signInInFlight = false;

export function isSignInInFlight(): boolean {
  return signInInFlight;
}

/**
 * Like AuthSession.useAutoDiscovery, but (a) only fetches when `enabled`, (b) swallows fetch/parse
 * failures with a warning instead of leaking an unhandled promise rejection, and (c) can be retried:
 * a failed fetch leaves `doc` null and `retry()` fetches again (signIn calls it on the next attempt).
 */
function useOidcDiscovery(
  issuer: string,
  enabled: boolean,
): { doc: AuthSession.DiscoveryDocument | null; pending: boolean; retry: () => void } {
  const [discovery, setDiscovery] = useState<AuthSession.DiscoveryDocument | null>(null);
  const [settled, setSettled] = useState(0);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    AuthSession.fetchDiscoveryAsync(issuer)
      .then((doc) => {
        if (alive) setDiscovery(doc);
      })
      .catch((err: unknown) => {
        if (alive) {
          setDiscovery(null);
          console.warn(`OIDC discovery failed for ${issuer}:`, err);
        }
      })
      .finally(() => {
        if (alive) setSettled(attempt + 1);
      });
    return () => {
      alive = false;
    };
  }, [issuer, enabled, attempt]);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  // Ignore any previously-fetched doc while disabled (mock mode) so the real flow
  // never runs against stale discovery.
  return {
    doc: enabled ? discovery : null,
    pending: enabled && discovery == null && settled <= attempt,
    retry,
  };
}

interface PreparedRequest {
  request: AuthSession.AuthRequest;
  discovery: AuthSession.DiscoveryDocument;
  generation: number;
}

/**
 * A PKCE request for `generation` with its authorization URL already built, so promptAsync opens the
 * browser without awaiting anything first. Bumping `generation` spends the current request: the next
 * one gets a new `state` and code verifier. Null while discovery or the request is still loading.
 */
function useFreshAuthRequest(
  discovery: AuthSession.DiscoveryDocument | null,
  generation: number,
): AuthSession.AuthRequest | null {
  const [prepared, setPrepared] = useState<PreparedRequest | null>(null);
  useEffect(() => {
    if (!discovery) return;
    let alive = true;
    const request = new AuthSession.AuthRequest(AUTH_REQUEST_CONFIG);
    request
      .makeAuthUrlAsync(discovery)
      .then(() => {
        if (alive) setPrepared({ request, discovery, generation });
      })
      .catch((err: unknown) => {
        if (alive) console.warn("could not prepare the sign-in request", err);
      });
    return () => {
      alive = false;
    };
  }, [discovery, generation]);
  return prepared?.discovery === discovery && prepared.generation === generation ? prepared.request : null;
}

export function useAuth() {
  const status = useAuthStore((s) => s.status);
  const mockMode = useAuthStore((s) => s.mockMode);
  const setStatus = useAuthStore((s) => s.setStatus);
  const setLastError = useAuthStore((s) => s.setLastError);

  // Only hit the IdP's discovery endpoint for the real PKCE flow. In mock mode we
  // never use `discovery`, and fetching it unconditionally turned any non-JSON
  // response from the issuer (WAF/captive-portal/redirect page — e.g. a body starting
  // with "Y") into an uncaught "JSON Parse error" on startup: expo's useAutoDiscovery
  // has no .catch, so the rejection escapes.
  const {
    doc: discovery,
    pending: discoveryPending,
    retry: retryDiscovery,
  } = useOidcDiscovery(OIDC_ISSUER, !mockMode);

  const [generation, setGeneration] = useState(0);
  const request = useFreshAuthRequest(discovery, generation);

  // Call straight from a press handler: on web the popup only opens inside the user gesture, so
  // nothing may be awaited before promptAsync.
  const signIn = useCallback(async () => {
    if (mockMode) {
      setLastError(null);
      await setTokens(mintMockToken());
      setStatus("authenticated");
      return;
    }
    if (!request || !discovery) {
      // Discovery still loading, or loaded and the PKCE request still being built: just wait.
      // Discovery failed: say so and fetch it again for the next attempt.
      const stillLoading = discoveryPending || discovery != null;
      setLastError(stillLoading ? "Sign-in is still loading. Try again in a moment." : IDP_UNREACHABLE_MESSAGE);
      if (!stillLoading) retryDiscovery();
      return;
    }
    setLastError(null);
    setStatus("authenticating");
    signInInFlight = true;
    // This request's state and verifier are spent whatever happens next: prepare new ones.
    setGeneration((g) => g + 1);
    try {
      const result = await request.promptAsync(discovery, { windowFeatures: {} });
      if (result.type !== "success" || !result.params.code) {
        // "dismiss"/"cancel": the user closed the browser. Not an error, just signed out again.
        setStatus("unauthenticated");
        if (result.type === "error") {
          setLastError(signInErrorMessage(result.error ?? new Error("the sign-in service returned an error")));
        }
        return;
      }
      const tokenResult = await AuthSession.exchangeCodeAsync(
        {
          clientId: OIDC_CLIENT_ID,
          code: result.params.code,
          redirectUri: OIDC_REDIRECT_URI,
          extraParams: request.codeVerifier
            ? { code_verifier: request.codeVerifier }
            : undefined,
        },
        discovery,
      );
      await setTokens(toStored(tokenResult));
      setLastError(null);
      setStatus("authenticated");
    } catch (err) {
      console.warn("sign-in failed", err);
      setStatus("unauthenticated");
      setLastError(signInErrorMessage(err));
    } finally {
      signInInFlight = false;
    }
  }, [mockMode, request, discovery, discoveryPending, retryDiscovery, setStatus, setLastError]);

  const signOut = useCallback(async () => {
    setLastError(null);
    await clearTokens();
    setStatus("unauthenticated");
  }, [setStatus, setLastError]);

  // The periodic refresh runs app-wide from the root layout; this is for explicit callers.
  const refreshIfNeeded = useCallback(async () => {
    await ensureFreshAccessToken();
  }, []);

  return useMemo(
    () => ({
      status,
      signIn,
      signOut,
      refreshIfNeeded,
      ready: !!request || mockMode,
      /** True while the IdP discovery document is still loading (the button can wait for it). */
      loading: !mockMode && !request && (discoveryPending || discovery != null),
    }),
    [status, signIn, signOut, refreshIfNeeded, request, mockMode, discoveryPending, discovery],
  );
}
