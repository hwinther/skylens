/**
 * On web the session lives in localStorage (expo-secure-store is an empty stub there), so it
 * survives a reload. Each case loads a fresh tokenStore with Platform.OS = "web" and a fake
 * localStorage, the same way settingsHydration.test.ts does for the settings store.
 */

import type { StoredTokens } from "@/auth/tokenStore";

jest.mock("react-native", () => ({ Platform: { OS: "web" } }));
jest.mock("expo-secure-store", () => ({}));

const KEY = "skylens.tokens.v1";

const TOKENS: StoredTokens = {
  accessToken: "at-1",
  refreshToken: "rt-1",
  idToken: "id-1",
  expiresAt: 1_700_000_000_000,
};

function installLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
  const data = new Map(Object.entries(initial));
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  };
  return data;
}

function loadTokenStore(): typeof import("@/auth/tokenStore") {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/auth/tokenStore") as typeof import("@/auth/tokenStore");
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

test("setTokens writes the session to localStorage under the token key", async () => {
  const data = installLocalStorage();
  const store = loadTokenStore();
  await store.setTokens(TOKENS);
  expect(store.TOKENS_KEY).toBe(KEY);
  expect(JSON.parse(data.get(KEY)!)).toEqual(TOKENS);
});

test("a reload (fresh module) hydrates the session from localStorage", async () => {
  installLocalStorage({ [KEY]: JSON.stringify(TOKENS) });
  const store = loadTokenStore();
  expect(store.getTokensSync()).toBeNull();
  await expect(store.hydrateTokens()).resolves.toEqual(TOKENS);
  expect(store.getAccessTokenSync()).toBe("at-1");
});

test("clearTokens removes the session from localStorage", async () => {
  const data = installLocalStorage({ [KEY]: JSON.stringify(TOKENS) });
  const store = loadTokenStore();
  await store.hydrateTokens();
  await store.clearTokens();
  expect(data.has(KEY)).toBe(false);
  expect(store.getTokensSync()).toBeNull();
});

test("readPersistedTokens sees another tab's write without touching memory", async () => {
  const data = installLocalStorage({ [KEY]: JSON.stringify(TOKENS) });
  const store = loadTokenStore();
  await store.hydrateTokens();
  data.set(KEY, JSON.stringify({ ...TOKENS, accessToken: "at-2" }));
  await expect(store.readPersistedTokens()).resolves.toMatchObject({ accessToken: "at-2" });
  expect(store.getAccessTokenSync()).toBe("at-1");
});

test("a corrupt stored value hydrates as signed out", async () => {
  installLocalStorage({ [KEY]: "{not json" });
  const store = loadTokenStore();
  await expect(store.hydrateTokens()).resolves.toBeNull();
});
