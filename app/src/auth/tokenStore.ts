/**
 * Token store: a small in-memory holder for the current access/refresh tokens, persisted so a
 * session survives restarts and reloads: expo-secure-store on native, localStorage on web (see
 * src/state/persistStorage). Under jest (no native module, no localStorage) it degrades to an
 * in-memory map.
 *
 * The in-memory copy is what the fetch client and SignalR accessTokenFactory read
 * synchronously on every request/connect, so they never hit storage on the hot path.
 * `hydrate()` loads the persisted tokens at startup (and again when another browser tab changed
 * them); `setTokens`/`clear` keep memory and storage in sync.
 *
 * On web several tabs share the one persisted token set, so refresh.ts re-reads it with
 * `readPersistedTokens()` before spending (or giving up on) a refresh token another tab may have
 * already rotated.
 */

import { platformStorage } from "@/state/persistStorage";

/** Storage key of the persisted token set (also watched by the web `storage` event listener). */
export const TOKENS_KEY = "skylens.tokens.v1";

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

const storage = platformStorage();

function parse(raw: string | null | undefined): StoredTokens | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredTokens | null;
    return parsed && typeof parsed.accessToken === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Read the persisted token set without touching the in-memory copy. */
export async function readPersistedTokens(): Promise<StoredTokens | null> {
  try {
    return parse(await storage.getItem(TOKENS_KEY));
  } catch {
    return null;
  }
}

/** Load persisted tokens into memory. Call at app start (and when another tab changed them). */
export async function hydrateTokens(): Promise<StoredTokens | null> {
  current = await readPersistedTokens();
  return current;
}

/** Persist and cache a new token set. */
export async function setTokens(tokens: StoredTokens): Promise<void> {
  current = tokens;
  try {
    await storage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  } catch {
    // The adapters already fall back to memory; nothing more to do.
  }
}

/** Read the current in-memory access token synchronously (for signalr/fetch). */
export function getAccessTokenSync(): string | null {
  return current?.accessToken ?? null;
}

/** Read the whole in-memory token set synchronously. */
export function getTokensSync(): StoredTokens | null {
  return current;
}

/** Clear tokens from memory and storage (sign-out). */
export async function clearTokens(): Promise<void> {
  current = null;
  try {
    await storage.removeItem(TOKENS_KEY);
  } catch {
    // See setTokens.
  }
}

/** True when `tokens` (default: the in-memory set) is missing or within `skewMs` of expiry. */
export function isExpired(skewMs = 60_000, now = Date.now(), tokens: StoredTokens | null = current): boolean {
  if (!tokens) return true;
  return now >= tokens.expiresAt - skewMs;
}
