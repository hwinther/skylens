/**
 * On web (and under jest) expo-secure-store is an empty stub whose methods throw. tokenStore must
 * degrade to its in-memory fallback so sign-in/out still works instead of crashing. Here every
 * SecureStore call rejects, and we assert set/clear/hydrate round-trip purely through memory.
 */

import {
  clearTokens,
  getAccessTokenSync,
  getTokensSync,
  hydrateTokens,
  setTokens,
  type StoredTokens,
} from "@/auth/tokenStore";

// jest.mock is hoisted above the import above, so tokenStore sees a SecureStore whose every
// method rejects — exactly the web/jest situation the in-memory fallback exists for.
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => {
    throw new Error("SecureStore is unavailable on web");
  }),
  setItemAsync: jest.fn(async () => {
    throw new Error("SecureStore is unavailable on web");
  }),
  deleteItemAsync: jest.fn(async () => {
    throw new Error("SecureStore is unavailable on web");
  }),
}));

const TOKENS: StoredTokens = {
  accessToken: "at-1",
  refreshToken: "rt-1",
  idToken: "id-1",
  expiresAt: 1_700_000_000_000,
  mock: false,
};

describe("tokenStore web fallback (SecureStore throws)", () => {
  afterEach(async () => {
    // Reset the module's in-memory holder + fallback map between tests.
    await clearTokens();
  });

  it("does not throw even though every SecureStore call rejects", async () => {
    await expect(setTokens(TOKENS)).resolves.toBeUndefined();
    await expect(hydrateTokens()).resolves.toEqual(TOKENS);
    await expect(clearTokens()).resolves.toBeUndefined();
  });

  it("caches the token synchronously for the fetch/signalr hot path", async () => {
    await setTokens(TOKENS);
    expect(getAccessTokenSync()).toBe("at-1");
    expect(getTokensSync()).toEqual(TOKENS);
  });

  it("round-trips set → hydrate through the memory fallback", async () => {
    await setTokens(TOKENS);
    // hydrate re-reads from storage; SecureStore rejects, so a non-null result can only have come
    // from the in-memory fallback (a JSON round-trip → a fresh, deep-equal object).
    const hydrated = await hydrateTokens();
    expect(hydrated).toEqual(TOKENS);
    expect(getAccessTokenSync()).toBe("at-1");
  });

  it("clears memory on sign-out so a later hydrate finds nothing", async () => {
    await setTokens(TOKENS);
    await clearTokens();
    expect(getTokensSync()).toBeNull();
    expect(getAccessTokenSync()).toBeNull();
    await expect(hydrateTokens()).resolves.toBeNull();
  });
});
