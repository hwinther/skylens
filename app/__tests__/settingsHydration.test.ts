/**
 * The onboarding gate in the root layout waits for settingsStore's `_hydrated` flag. On web the store
 * persists to localStorage, which is synchronous, so zustand persist rehydrates inside create(). The
 * flag must still flip (it used to throw a swallowed ReferenceError there, so web never onboarded).
 */

jest.mock("react-native", () => ({ Platform: { OS: "web" } }));
jest.mock("expo-secure-store", () => ({}));

const KEY = "skylens.settings.v1";

function installLocalStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  };
}

async function loadStore() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useSettingsStore } = require("@/state/settingsStore") as typeof import("@/state/settingsStore");
  await Promise.resolve(); // let the deferred hydration flag land
  return useSettingsStore;
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

test("a fresh web install hydrates and is not onboarded", async () => {
  installLocalStorage();
  const store = await loadStore();
  expect(store.getState()._hydrated).toBe(true);
  expect(store.getState().onboarded).toBe(false);
});

test("a returning web user hydrates with their saved onboarding flag", async () => {
  installLocalStorage({ [KEY]: JSON.stringify({ state: { onboarded: true }, version: 0 }) });
  const store = await loadStore();
  expect(store.getState()._hydrated).toBe(true);
  expect(store.getState().onboarded).toBe(true);
});
