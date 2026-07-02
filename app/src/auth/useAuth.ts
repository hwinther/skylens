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
 * Mock mode short-circuits all of this and mints a fake token so the app is usable
 * in Expo Go before the dev build exists.
 */

import { useCallback, useEffect, useMemo } from "react";
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
  const discovery = AuthSession.useAutoDiscovery(OIDC_ISSUER);
  const status = useAuthStore((s) => s.status);
  const mockMode = useAuthStore((s) => s.mockMode);
  const setStatus = useAuthStore((s) => s.setStatus);

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
