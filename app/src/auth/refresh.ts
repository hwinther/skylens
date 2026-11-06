/**
 * Hook-free token refresh, shared by every caller that needs a usable access token: the SignalR
 * accessTokenFactory (on each connect/reconnect), the app-wide refresh timer in the root layout,
 * and useAuth().refreshIfNeeded.
 *
 * It used to live inside useAuth, whose timer only ran while a screen using that hook (Settings,
 * Sign-in) was mounted. After expiry, the hub's automatic reconnect kept presenting the stale token
 * and failing, so the app looked signed in but received no data until a sign-out/sign-in.
 *
 * Concurrent callers share one in-flight refresh. The discovery document is fetched lazily and
 * cached; a failed fetch is not cached, so the next call retries it.
 */

import * as AuthSession from "expo-auth-session";
import { OIDC_CLIENT_ID, OIDC_ISSUER } from "./config";
import { clearTokens, getTokensSync, isExpired, setTokens, type StoredTokens } from "./tokenStore";
import { useAuthStore } from "@/state/authStore";

export function toStored(result: AuthSession.TokenResponse, now = Date.now()): StoredTokens {
  const expiresInMs = (result.expiresIn ?? 3600) * 1000;
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken ?? null,
    idToken: result.idToken ?? null,
    expiresAt: now + expiresInMs,
  };
}

let discoveryPromise: Promise<AuthSession.DiscoveryDocument> | null = null;

function getDiscovery(): Promise<AuthSession.DiscoveryDocument> {
  discoveryPromise ??= AuthSession.fetchDiscoveryAsync(OIDC_ISSUER).catch((err: unknown) => {
    discoveryPromise = null;
    throw err;
  });
  return discoveryPromise;
}

async function endSession(): Promise<null> {
  await clearTokens();
  useAuthStore.getState().setStatus("unauthenticated");
  return null;
}

async function refreshNow(): Promise<string | null> {
  const tokens = getTokensSync();
  if (!tokens) return null;
  if (!tokens.refreshToken) return endSession();

  let discovery: AuthSession.DiscoveryDocument;
  try {
    discovery = await getDiscovery();
  } catch (err) {
    // The IdP is unreachable (offline, captive portal): keep the session and try again on the next
    // call. The stale token goes out meanwhile, the server rejects it, and the hub retries.
    console.warn("token refresh: OIDC discovery failed", err);
    return tokens.accessToken;
  }

  try {
    const refreshed = await AuthSession.refreshAsync(
      { clientId: OIDC_CLIENT_ID, refreshToken: tokens.refreshToken },
      discovery,
    );
    const next = toStored(refreshed);
    await setTokens({ ...next, refreshToken: next.refreshToken ?? tokens.refreshToken });
    return next.accessToken;
  } catch (err) {
    // The IdP rejected the refresh token: the session is over, so show it as signed out.
    console.warn("token refresh rejected", err);
    return endSession();
  }
}

let inflight: Promise<string | null> | null = null;

/**
 * The current access token, refreshed first when it is expired or about to expire. Mock tokens
 * and a missing session pass straight through.
 */
export function ensureFreshAccessToken(): Promise<string | null> {
  const tokens = getTokensSync();
  if (!tokens || tokens.mock || !isExpired()) return Promise.resolve(tokens?.accessToken ?? null);
  inflight ??= refreshNow().finally(() => {
    inflight = null;
  });
  return inflight;
}
