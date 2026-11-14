/**
 * A 401 from the backend while the app holds a session it believes valid (token revoked, clock off):
 * ApiClient forces one refresh and retries the request once. When that refresh fails the session ends,
 * so the app shows signed out (and the sign-in card) instead of silently empty layers.
 *
 * Runs the real refresh/tokenStore/authStore modules; only the IdP (expo-auth-session) and native
 * storage are mocked. Kept apart from apiClient.test.ts, which mocks the refresh module wholesale.
 */

import type { StoredTokens } from "@/auth/tokenStore";

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

let ApiClient: typeof import("@/api/client").ApiClient;
let tokens: typeof import("@/auth/tokenStore");
let useAuthStore: typeof import("@/state/authStore").useAuthStore;
let refreshAsync: jest.Mock;

const VALID: StoredTokens = {
  accessToken: "revoked",
  refreshToken: "rt-1",
  idToken: null,
  expiresAt: Date.now() + 3_600_000,
};

function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Skylens-Api": "1" },
  });
}

beforeEach(() => {
  jest.resetModules();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  /* eslint-disable @typescript-eslint/no-require-imports */
  ({ ApiClient } = require("@/api/client"));
  tokens = require("@/auth/tokenStore");
  ({ useAuthStore } = require("@/state/authStore"));
  const AuthSession = require("expo-auth-session");
  /* eslint-enable @typescript-eslint/no-require-imports */
  AuthSession.fetchDiscoveryAsync.mockResolvedValue({ tokenEndpoint: "https://idp/token" });
  refreshAsync = AuthSession.refreshAsync;
  useAuthStore.setState({ status: "authenticated", authRequired: true });
});

afterEach(() => jest.restoreAllMocks());

test("a 401 with a valid-looking token refreshes once and retries with the new token", async () => {
  await tokens.setTokens(VALID);
  refreshAsync.mockResolvedValue({ accessToken: "fresh", refreshToken: "rt-2", expiresIn: 3600 });
  const seen: (string | null)[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("Authorization");
    seen.push(auth);
    return auth === "Bearer fresh" ? response(200, { sub: "u" }) : response(401);
  }) as unknown as typeof fetch;

  const client = new ApiClient({ baseUrl: "http://x", fetchImpl });
  await expect(client.me()).resolves.toEqual({ sub: "u" });

  expect(seen).toEqual(["Bearer revoked", "Bearer fresh"]);
  expect(refreshAsync).toHaveBeenCalledTimes(1);
  expect(tokens.getTokensSync()).toMatchObject({ accessToken: "fresh", refreshToken: "rt-2" });
  expect(useAuthStore.getState().status).toBe("authenticated");
});

test("retries only once: a second 401 after the refresh is reported, not looped", async () => {
  await tokens.setTokens(VALID);
  refreshAsync.mockResolvedValue({ accessToken: "fresh", expiresIn: 3600 });
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return response(401);
  }) as unknown as typeof fetch;

  const client = new ApiClient({ baseUrl: "http://x", fetchImpl });
  await expect(client.me()).rejects.toMatchObject({ status: 401 });
  expect(calls).toBe(2);
  expect(refreshAsync).toHaveBeenCalledTimes(1);
});

test("a failed refresh ends the session: signed out, tokens cleared, the 401 surfaces", async () => {
  await tokens.setTokens(VALID);
  refreshAsync.mockRejectedValue(Object.assign(new Error("invalid_grant"), { code: "invalid_grant" }));
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return response(401);
  }) as unknown as typeof fetch;

  const client = new ApiClient({ baseUrl: "http://x", fetchImpl });
  await expect(client.me()).rejects.toMatchObject({ status: 401 });

  expect(calls).toBe(1);
  expect(tokens.getTokensSync()).toBeNull();
  expect(useAuthStore.getState().status).toBe("unauthenticated");
});

test("an injected token source and mock tokens are never refreshed on 401", async () => {
  await tokens.setTokens({ ...VALID, accessToken: "mock", mock: true });
  const fetchImpl = (async () => response(401)) as unknown as typeof fetch;

  await expect(new ApiClient({ baseUrl: "http://x", fetchImpl }).me()).rejects.toMatchObject({
    status: 401,
  });
  await expect(
    new ApiClient({ baseUrl: "http://x", getToken: () => "injected", fetchImpl }).me(),
  ).rejects.toMatchObject({ status: 401 });
  expect(refreshAsync).not.toHaveBeenCalled();
  expect(useAuthStore.getState().status).toBe("authenticated");
});

test("a 401 while the IdP can't be reached keeps the session and does not retry", async () => {
  await tokens.setTokens(VALID);
  refreshAsync.mockRejectedValue(new TypeError("Network request failed"));
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return response(401);
  }) as unknown as typeof fetch;

  await expect(new ApiClient({ baseUrl: "http://x", fetchImpl }).me()).rejects.toMatchObject({ status: 401 });

  expect(calls).toBe(1);
  expect(tokens.getTokensSync()).toMatchObject({ accessToken: VALID.accessToken });
  expect(useAuthStore.getState().status).toBe("authenticated");
});
