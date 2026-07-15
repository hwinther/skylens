/**
 * expo-auth-session PKCE (S256) sign-in against Authelia, plus token persistence
 * and refresh. Exposes a hook the sign-in screen and app root use.
 *
 * Flow:
 *  - useAutoDiscovery loads the OIDC discovery document from auth.wsh.no.
 *  - useAuthRequest builds a PKCE (S256) request for the `skylens` public client.
 *  - On success we exchange the code for tokens (exchangeCodeAsync), persist them,
 *    and mark the session authenticated.
 *  - refreshIfNeeded() uses the refresh token to renew silently before expiry.
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
import { mintMockToken } from "./mockAuth";
import {
  clearTokens,
  getTokensSync,
  isExpired,
  setTokens,
  type StoredTokens,
} from "./tokenStore";
import { useAuthStore } from "@/state/authStore";

// Required so the OAuth popup dismisses cleanly on native.
WebBrowser.maybeCompleteAuthSession();

export const OIDC_REDIRECT_URI = AuthSession.makeRedirectUri({
  scheme: OIDC_SCHEME,
  path: OIDC_REDIRECT_PATH,
});

/**
 * Like AuthSession.useAutoDiscovery, but (a) only fetches when `enabled` and (b)
 * swallows fetch/parse failures with a warning instead of leaking an unhandled
 * promise rejection. Returns null until — and unless — the document loads, which is
 * the same contract signIn() already guards on (`if (!request || !discovery) return`).
 */
function useOidcDiscovery(
  issuer: string,
  enabled: boolean,
): AuthSession.DiscoveryDocument | null {
  const [discovery, setDiscovery] =
    useState<AuthSession.DiscoveryDocument | null>(null);
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
      });
    return () => {
      alive = false;
    };
  }, [issuer, enabled]);
  // Ignore any previously-fetched doc while disabled (mock mode) so the real flow
  // never runs against stale discovery.
  return enabled ? discovery : null;
}

function toStored(result: AuthSession.TokenResponse, now = Date.now()): StoredTokens {
  const expiresInMs = (result.expiresIn ?? 3600) * 1000;
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken ?? null,
    idToken: result.idToken ?? null,
    expiresAt: now + expiresInMs,
  };
}

export function useAuth() {
  const status = useAuthStore((s) => s.status);
  const mockMode = useAuthStore((s) => s.mockMode);
  const setStatus = useAuthStore((s) => s.setStatus);

  // Only hit the IdP's discovery endpoint for the real PKCE flow. In mock mode we
  // never use `discovery`, and fetching it unconditionally turned any non-JSON
  // response from the issuer (WAF/captive-portal/redirect page — e.g. a body starting
  // with "Y") into an uncaught "JSON Parse error" on startup: expo's useAutoDiscovery
  // has no .catch, so the rejection escapes.
  const discovery = useOidcDiscovery(OIDC_ISSUER, !mockMode);

  const [request, , promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: OIDC_CLIENT_ID,
      scopes: OIDC_SCOPES,
      redirectUri: OIDC_REDIRECT_URI,
      usePKCE: true,
      // Ask Authelia to include the API audience in the access token.
      extraParams: { audience: OIDC_AUDIENCE },
    },
    discovery,
  );

  const signIn = useCallback(async () => {
    if (mockMode) {
      await setTokens(mintMockToken());
      setStatus("authenticated");
      return;
    }
    if (!request || !discovery) return;
    setStatus("authenticating");
    const result = await promptAsync();
    if (result.type !== "success" || !result.params.code) {
      setStatus("unauthenticated");
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
    setStatus("authenticated");
  }, [mockMode, request, discovery, promptAsync, setStatus]);

  const signOut = useCallback(async () => {
    await clearTokens();
    setStatus("unauthenticated");
  }, [setStatus]);

  const refreshIfNeeded = useCallback(async () => {
    const tokens = getTokensSync();
    if (!tokens || tokens.mock) return;
    if (!isExpired()) return;
    if (!tokens.refreshToken || !discovery) {
      await signOut();
      return;
    }
    try {
      const refreshed = await AuthSession.refreshAsync(
        { clientId: OIDC_CLIENT_ID, refreshToken: tokens.refreshToken },
        discovery,
      );
      await setTokens({ ...toStored(refreshed), refreshToken: refreshed.refreshToken ?? tokens.refreshToken });
    } catch {
      await signOut();
    }
  }, [discovery, signOut]);

  useEffect(() => {
    // Keep the token fresh while the app is open.
    const id = setInterval(() => {
      void refreshIfNeeded();
    }, 60_000);
    return () => clearInterval(id);
  }, [refreshIfNeeded]);

  return useMemo(
    () => ({ status, signIn, signOut, refreshIfNeeded, ready: !!request || mockMode }),
    [status, signIn, signOut, refreshIfNeeded, request, mockMode],
  );
}
