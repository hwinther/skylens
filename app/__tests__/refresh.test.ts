/**
 * ensureFreshAccessToken: the hub's accessTokenFactory and the root layout's timer call it, so an
 * expired token is renewed no matter which screen is mounted. Without it, the hub's automatic
 * reconnect kept presenting a stale token and the app sat signed in with no data.
 */

import type { StoredTokens } from "@/auth/tokenStore";

// refresh.ts caches discovery and the in-flight refresh at module scope, so each test loads fresh
// copies of it and of the stores it shares state with.
let ensureFreshAccessToken: typeof import("@/auth/refresh").ensureFreshAccessToken;
let forceRefreshAccessToken: typeof import("@/auth/refresh").forceRefreshAccessToken;
let storage: import("zustand/middleware").StateStorage;
let tokens: typeof import("@/auth/tokenStore");
let useAuthStore: typeof import("@/state/authStore").useAuthStore;
let fetchDiscovery: jest.Mock;
let refreshAsync: jest.Mock;

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => {
    throw new Error("unavailable");
  }),
  setItemAsync: jest.fn(async () => {
    throw new Error("unavailable");
  }),
  deleteItemAsync: jest.fn(async () => {
    throw new Error("unavailable");
  }),
}));

jest.mock("expo-auth-session", () => ({
  fetchDiscoveryAsync: jest.fn(),
  refreshAsync: jest.fn(),
}));

const EXPIRED: StoredTokens = {
  accessToken: "stale",
  refreshToken: "rt-1",
  idToken: null,
  expiresAt: Date.now() - 1000,
};

beforeEach(() => {
  jest.resetModules();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  /* eslint-disable @typescript-eslint/no-require-imports */
  ({ ensureFreshAccessToken, forceRefreshAccessToken } = require("@/auth/refresh"));
  // The same storage adapter tokenStore persists through; writing to it stands in for another tab.
  storage = require("@/state/persistStorage").platformStorage();
  tokens = require("@/auth/tokenStore");
  ({ useAuthStore } = require("@/state/authStore"));
  const AuthSession = require("expo-auth-session");
  /* eslint-enable @typescript-eslint/no-require-imports */
  fetchDiscovery = AuthSession.fetchDiscoveryAsync;
  refreshAsync = AuthSession.refreshAsync;
  fetchDiscovery.mockResolvedValue({ tokenEndpoint: "https://idp/token" });
  useAuthStore.setState({ status: "authenticated" });
});

afterEach(() => jest.restoreAllMocks());

test("returns a still-valid token without refreshing", async () => {
  await tokens.setTokens({ ...EXPIRED, accessToken: "good", expiresAt: Date.now() + 3_600_000 });
  await expect(ensureFreshAccessToken()).resolves.toBe("good");
  expect(refreshAsync).not.toHaveBeenCalled();
});

test("refreshes an expired token and keeps the refresh token when none is returned", async () => {
  await tokens.setTokens(EXPIRED);
  refreshAsync.mockResolvedValue({ accessToken: "fresh", expiresIn: 3600 });

  await expect(ensureFreshAccessToken()).resolves.toBe("fresh");
  expect(tokens.getTokensSync()).toMatchObject({ accessToken: "fresh", refreshToken: "rt-1" });
  expect(useAuthStore.getState().status).toBe("authenticated");
});

test("concurrent callers share one refresh", async () => {
  await tokens.setTokens(EXPIRED);
  refreshAsync.mockResolvedValue({ accessToken: "fresh", expiresIn: 3600 });

  const results = await Promise.all([ensureFreshAccessToken(), ensureFreshAccessToken()]);
  expect(results).toEqual(["fresh", "fresh"]);
  expect(refreshAsync).toHaveBeenCalledTimes(1);
});

test("a rejected refresh ends the session so the UI shows signed out", async () => {
  await tokens.setTokens(EXPIRED);
  refreshAsync.mockRejectedValue(new Error("invalid_grant"));

  await expect(ensureFreshAccessToken()).resolves.toBeNull();
  expect(tokens.getTokensSync()).toBeNull();
  expect(useAuthStore.getState().status).toBe("unauthenticated");
});

test("an unreachable IdP keeps the session and retries discovery next time", async () => {
  await tokens.setTokens(EXPIRED);
  fetchDiscovery.mockRejectedValueOnce(new Error("offline"));

  await expect(ensureFreshAccessToken()).resolves.toBe("stale");
  expect(useAuthStore.getState().status).toBe("authenticated");

  refreshAsync.mockResolvedValue({ accessToken: "fresh", expiresIn: 3600 });
  await expect(ensureFreshAccessToken()).resolves.toBe("fresh");
  expect(fetchDiscovery).toHaveBeenCalledTimes(2);
});

test("mock tokens pass through untouched", async () => {
  await tokens.setTokens({ ...EXPIRED, accessToken: "mock", mock: true });
  await expect(ensureFreshAccessToken()).resolves.toBe("mock");
  expect(refreshAsync).not.toHaveBeenCalled();
});

/** Another tab persisting its own (refreshed) token set. */
async function otherTabWrites(t: StoredTokens) {
  await storage.setItem("skylens.tokens.v1", JSON.stringify(t));
}

const OTHER_TAB: StoredTokens = {
  accessToken: "other-tab",
  refreshToken: "rt-2",
  idToken: null,
  expiresAt: Date.now() + 3_600_000,
};

test("adopts a token set another tab already refreshed instead of spending the refresh token", async () => {
  await tokens.setTokens(EXPIRED);
  await otherTabWrites(OTHER_TAB);

  await expect(ensureFreshAccessToken()).resolves.toBe("other-tab");
  expect(refreshAsync).not.toHaveBeenCalled();
  expect(tokens.getTokensSync()).toMatchObject({ accessToken: "other-tab", refreshToken: "rt-2" });
});

test("ignores another tab's set when it is expired too, and refreshes", async () => {
  await tokens.setTokens(EXPIRED);
  await otherTabWrites({ ...OTHER_TAB, expiresAt: Date.now() - 1000 });
  refreshAsync.mockResolvedValue({ accessToken: "fresh", expiresIn: 3600 });

  await expect(ensureFreshAccessToken()).resolves.toBe("fresh");
  expect(refreshAsync).toHaveBeenCalledTimes(1);
});

test("a rejected refresh re-reads storage and adopts a set another tab rotated in meanwhile", async () => {
  await tokens.setTokens(EXPIRED);
  refreshAsync.mockImplementation(async () => {
    // The other tab won the race: it rotated the refresh token, so ours is now rejected.
    await otherTabWrites(OTHER_TAB);
    throw new Error("invalid_grant");
  });

  await expect(ensureFreshAccessToken()).resolves.toBe("other-tab");
  expect(useAuthStore.getState().status).toBe("authenticated");
  expect(tokens.getTokensSync()).toMatchObject({ accessToken: "other-tab" });
});

test("forceRefreshAccessToken refreshes a token that still looks valid", async () => {
  await tokens.setTokens({ ...EXPIRED, accessToken: "rejected", expiresAt: Date.now() + 3_600_000 });
  refreshAsync.mockResolvedValue({ accessToken: "fresh", expiresIn: 3600 });

  await expect(forceRefreshAccessToken()).resolves.toBe("fresh");
  expect(refreshAsync).toHaveBeenCalledTimes(1);
});

test("forceRefreshAccessToken ends the session when the refresh is rejected", async () => {
  await tokens.setTokens({ ...EXPIRED, accessToken: "rejected", expiresAt: Date.now() + 3_600_000 });
  refreshAsync.mockRejectedValue(new Error("invalid_grant"));

  await expect(forceRefreshAccessToken()).resolves.toBeNull();
  expect(useAuthStore.getState().status).toBe("unauthenticated");
});
