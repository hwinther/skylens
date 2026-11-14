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
 *
 * On web every tab shares the one token set in localStorage, and Authelia may rotate the refresh
 * token on use. So before refreshing, and again before giving up on a rejected refresh token, the
 * persisted set is re-read: if another tab already stored a newer one, this tab adopts it instead
 * of spending (or ending the session over) a refresh token that is no longer current.
 *
 * The session only ends when the IdP answers that the refresh token is invalid (an OAuth error such
 * as `invalid_grant`, see ./errors). A refresh that gets no answer (offline, a phone resuming before
 * its network is back) or a non-OAuth one (a proxy's error page) keeps the session for the next try.
 */

import * as AuthSession from "expo-auth-session";
import { OIDC_CLIENT_ID, OIDC_ISSUER } from "./config";
import { isSessionEndingRefreshError, SESSION_ENDED_MESSAGE } from "./errors";
import {
  clearTokens,
  getTokensSync,
  hydrateTokens,
  isExpired,
  readPersistedTokens,
  setTokens,
  type StoredTokens,
} from "./tokenStore";
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

/**
 * The IdP ended the session: clear it and show it as signed out (the sign-in prompt appears where
 * sign-in is required), with a message saying why on the sign-in surfaces.
 */
export async function endSession(): Promise<null> {
  await clearTokens();
  const auth = useAuthStore.getState();
  auth.setLastError(SESSION_ENDED_MESSAGE);
  auth.setStatus("unauthenticated");
  return null;
}

function sameTokens(a: StoredTokens | null, b: StoredTokens | null): boolean {
  return a?.accessToken === b?.accessToken && a?.refreshToken === b?.refreshToken;
}

/**
 * Another tab's token set, when storage holds one that differs from `tokens` and (when
 * `requireFresh`) is not about to expire; adopted into memory. Null otherwise.
 */
async function adoptFromOtherTab(tokens: StoredTokens, requireFresh: boolean): Promise<StoredTokens | null> {
  const stored = await readPersistedTokens();
  if (!stored || stored.mock || sameTokens(stored, tokens)) return null;
  if (requireFresh && isExpired(60_000, Date.now(), stored)) return null;
  return hydrateTokens();
}

async function refreshNow(): Promise<string | null> {
  const tokens = getTokensSync();
  if (!tokens) return null;

  // Another tab may already have refreshed (and rotated the refresh token): use its result.
  const adopted = await adoptFromOtherTab(tokens, true);
  if (adopted) return adopted.accessToken;

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
    if (typeof refreshed.accessToken !== "string" || !refreshed.accessToken) {
      throw new Error("the token endpoint answered without an access token");
    }
    const next = toStored(refreshed);
    await setTokens({ ...next, refreshToken: next.refreshToken ?? tokens.refreshToken });
    return next.accessToken;
  } catch (err) {
    if (!isSessionEndingRefreshError(err)) {
      // No answer, or not an OAuth one: nothing says the refresh token is bad. Keep the session and
      // try again on the next call, as for an unreachable discovery document above.
      console.warn("token refresh failed; keeping the session", err);
      return tokens.accessToken;
    }
    // The IdP rejected the refresh token. Another tab may have rotated it meanwhile; if storage now
    // holds a different set, use that. Otherwise the session is over, so show it as signed out.
    const rotated = await adoptFromOtherTab(tokens, false);
    if (rotated) return rotated.accessToken;
    console.warn("token refresh rejected", err);
    return endSession();
  }
}

let inflight: Promise<string | null> | null = null;

function sharedRefresh(): Promise<string | null> {
  inflight ??= refreshNow().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * The current access token, refreshed first when it is expired or about to expire. Mock tokens
 * and a missing session pass straight through.
 */
export function ensureFreshAccessToken(): Promise<string | null> {
  const tokens = getTokensSync();
  if (!tokens || tokens.mock || !isExpired()) return Promise.resolve(tokens?.accessToken ?? null);
  return sharedRefresh();
}

/**
 * Refresh now even though the access token looks valid: the backend just rejected it (revoked, or
 * the clock is off). Shares the single-flight with ensureFreshAccessToken. Resolves to the new access
 * token, or null when there is no session or it had to end.
 */
export function forceRefreshAccessToken(): Promise<string | null> {
  const tokens = getTokensSync();
  if (!tokens || tokens.mock) return Promise.resolve(null);
  return sharedRefresh();
}
