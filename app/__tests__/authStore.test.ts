/**
 * The auth store's `mockMode` default is computed once at module load from __DEV__ and
 * EXPO_PUBLIC_FORCE_LIVE (the same override settingsStore uses for demoMode). Mock auth is a dev
 * convenience: dev environments (Expo Go / metro) default to mock unless FORCE_LIVE is baked in;
 * release builds (standalone Android/iOS, static web export) always boot into the real OIDC flow —
 * a Play-track install must never come up preselected on mock. Each case re-imports the store in an
 * isolated registry so the module-level default is re-evaluated; `__DEV__` is toggled the same way
 * apiConfig.test.ts does to reach the release branch.
 */

function freshMockModeDefault(): boolean {
  let value = false;
  jest.isolateModules(() => {
    // A fresh require inside the isolated registry re-runs the module-level default computation;
    // a static import would be evaluated once and cached, defeating the point.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@/state/authStore") as typeof import("@/state/authStore");
    value = mod.useAuthStore.getState().mockMode;
  });
  return value;
}

describe("authStore mockMode default", () => {
  const g = globalThis as { __DEV__?: boolean };
  const origDev = g.__DEV__;
  const orig = process.env.EXPO_PUBLIC_FORCE_LIVE;

  afterEach(() => {
    g.__DEV__ = origDev;
    if (orig === undefined) delete process.env.EXPO_PUBLIC_FORCE_LIVE;
    else process.env.EXPO_PUBLIC_FORCE_LIVE = orig;
  });

  describe("dev build (__DEV__ true)", () => {
    beforeEach(() => {
      g.__DEV__ = true;
    });

    it("defaults to mock mode when FORCE_LIVE is unset", () => {
      delete process.env.EXPO_PUBLIC_FORCE_LIVE;
      expect(freshMockModeDefault()).toBe(true);
    });

    it("boots live (mock off) when FORCE_LIVE=1", () => {
      process.env.EXPO_PUBLIC_FORCE_LIVE = "1";
      expect(freshMockModeDefault()).toBe(false);
    });

    it("boots live (mock off) when FORCE_LIVE=true", () => {
      process.env.EXPO_PUBLIC_FORCE_LIVE = "true";
      expect(freshMockModeDefault()).toBe(false);
    });

    it("stays on mock mode for any other FORCE_LIVE value", () => {
      process.env.EXPO_PUBLIC_FORCE_LIVE = "0";
      expect(freshMockModeDefault()).toBe(true);
    });
  });

  describe("release build (__DEV__ false)", () => {
    beforeEach(() => {
      g.__DEV__ = false;
    });

    it("boots live even when FORCE_LIVE is unset (standalone Android/iOS)", () => {
      delete process.env.EXPO_PUBLIC_FORCE_LIVE;
      expect(freshMockModeDefault()).toBe(false);
    });

    it("boots live when FORCE_LIVE=1 (hosted web export)", () => {
      process.env.EXPO_PUBLIC_FORCE_LIVE = "1";
      expect(freshMockModeDefault()).toBe(false);
    });
  });
});
