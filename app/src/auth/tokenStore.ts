/**
 * Token store: a small in-memory holder for the current access/refresh tokens,
 * persisted to expo-secure-store so a session survives app restarts.
 *
 * The in-memory copy is what the fetch client and SignalR accessTokenFactory read
 * synchronously on every request/connect, so they never hit disk on the hot path.
 * `hydrate()` loads the persisted tokens once at startup; `setTokens`/`clear`
 * keep memory and disk in sync.
 */

import * as SecureStore from "expo-secure-store";

const KEY = "skylens.tokens.v1";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** Absolute epoch milliseconds at which the access token expires. */
  expiresAt: number;
  /** True when these are the fake tokens from mock-auth mode. */
  mock?: boolean;
}

let current: StoredTokens | null = null;

/** Load persisted tokens into memory. Call once at app start. */
export async function hydrateTokens(): Promise<StoredTokens | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) {
      current = null;
      return null;
    }
    current = JSON.parse(raw) as StoredTokens;
    return current;
  } catch {
    current = null;
    return null;
  }
}

/** Persist and cache a new token set. */
export async function setTokens(tokens: StoredTokens): Promise<void> {
  current = tokens;
  await SecureStore.setItemAsync(KEY, JSON.stringify(tokens));
}

/** Read the current in-memory access token synchronously (for signalr/fetch). */
export function getAccessTokenSync(): string | null {
  return current?.accessToken ?? null;
}

/** Read the whole in-memory token set synchronously. */
export function getTokensSync(): StoredTokens | null {
  return current;
}

/** Clear tokens from memory and disk (sign-out). */
export async function clearTokens(): Promise<void> {
  current = null;
  await SecureStore.deleteItemAsync(KEY);
}

/** True when the access token is missing or within `skewMs` of expiry. */
export function isExpired(skewMs = 60_000, now = Date.now()): boolean {
  if (!current) return true;
  return now >= current.expiresAt - skewMs;
}
