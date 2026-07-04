/**
 * The auth store's `mockMode` default is computed once at module load from EXPO_PUBLIC_FORCE_LIVE
 * (the same override settingsStore uses for demoMode). The hosted web build bakes FORCE_LIVE=1 so
 * it boots into the real OIDC flow; native/Expo-Go dev (env unset) stays on mock auth. Each case
 * re-imports the store in an isolated registry so the module-level default is re-evaluated.
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
  const orig = process.env.EXPO_PUBLIC_FORCE_LIVE;

  afterEach(() => {
    if (orig === undefined) delete process.env.EXPO_PUBLIC_FORCE_LIVE;
    else process.env.EXPO_PUBLIC_FORCE_LIVE = orig;
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
