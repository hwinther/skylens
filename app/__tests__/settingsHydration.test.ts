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

test("a Polaris calibration left armed at a force-quit is not re-armed on the next launch", async () => {
  installLocalStorage({
    [KEY]: JSON.stringify({ state: { polarisCalibrating: true, azimuthTrimDeg: 3 }, version: 0 }),
  });
  const store = await loadStore();
  expect(store.getState().polarisCalibrating).toBe(false);
  expect(store.getState().azimuthTrimDeg).toBe(3);
});

test("calibration and layer choices survive a restart", async () => {
  installLocalStorage();
  const first = await loadStore();
  first.getState().setAzimuthTrim(-7);
  first.getState().setHFov(70);
  first.getState().setShowRadioSky(true);
  first.getState().setOnboarded(true);

  // Same storage, fresh module: what a relaunch sees.
  const relaunched = await loadStore();
  expect(relaunched.getState()).toMatchObject({
    azimuthTrimDeg: -7,
    hFovDeg: 70,
    showRadioSky: true,
    onboarded: true,
  });
});

test("the List filter and collapsed sections survive a restart", async () => {
  installLocalStorage();
  const first = await loadStore();
  first.getState().toggleListKind("sea");
  first.getState().toggleListSection("overhead");

  const relaunched = await loadStore();
  expect(relaunched.getState().listHiddenKinds).toEqual(["sea"]);
  expect(relaunched.getState().listCollapsedSections).toEqual(["overhead"]);
});

test("settings saved before the List filter existed load with nothing hidden or collapsed", async () => {
  installLocalStorage({ [KEY]: JSON.stringify({ state: { onboarded: true, showShips: false }, version: 0 }) });
  const store = await loadStore();
  expect(store.getState()).toMatchObject({
    onboarded: true,
    showShips: false,
    listHiddenKinds: [],
    listCollapsedSections: [],
  });
});

test("unknown List kinds and sections in storage are ignored", async () => {
  installLocalStorage({
    [KEY]: JSON.stringify({
      state: { listHiddenKinds: ["comets", "sea", "sea"], listCollapsedSections: "radio" },
      version: 0,
    }),
  });
  const store = await loadStore();
  expect(store.getState().listHiddenKinds).toEqual(["sea"]);
  expect(store.getState().listCollapsedSections).toEqual([]);
});

test("the cockpit layer filter survives a restart; unknown or missing layers are ignored", async () => {
  installLocalStorage();
  const first = await loadStore();
  first.getState().toggleSimLayer("ferries");
  first.getState().toggleSimLayer("aircraft");
  expect(first.getState().simHiddenLayers).toEqual(["aircraft", "ferries"]);
  const saved = (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(KEY);
  installLocalStorage({ [KEY]: saved! });
  const relaunched = await loadStore();
  expect(relaunched.getState().simHiddenLayers).toEqual(["aircraft", "ferries"]);

  installLocalStorage({
    [KEY]: JSON.stringify({ state: { simHiddenLayers: ["comets", "ports", "ports"] }, version: 0 }),
  });
  expect((await loadStore()).getState().simHiddenLayers).toEqual(["ports"]);

  installLocalStorage({ [KEY]: JSON.stringify({ state: { onboarded: true }, version: 0 }) });
  expect((await loadStore()).getState().simHiddenLayers).toEqual([]);
});

test("the map satellites layer defaults on, and a saved choice (only a boolean) is kept", async () => {
  installLocalStorage({ [KEY]: JSON.stringify({ state: { onboarded: true }, version: 0 }) });
  expect((await loadStore()).getState().showMapSatellites).toBe(true);

  installLocalStorage({ [KEY]: JSON.stringify({ state: { showMapSatellites: false }, version: 0 }) });
  expect((await loadStore()).getState().showMapSatellites).toBe(false);

  installLocalStorage({ [KEY]: JSON.stringify({ state: { showMapSatellites: "nope" }, version: 0 }) });
  expect((await loadStore()).getState().showMapSatellites).toBe(true);
});

test("the radar tilt survives a restart, sanitised to whole degrees within range", async () => {
  installLocalStorage({ [KEY]: JSON.stringify({ state: { radarTiltDeg: 37.6 }, version: 0 }) });
  expect((await loadStore()).getState().radarTiltDeg).toBe(38);

  installLocalStorage({ [KEY]: JSON.stringify({ state: { radarTiltDeg: 400 }, version: 0 }) });
  expect((await loadStore()).getState().radarTiltDeg).toBe(60);

  installLocalStorage({ [KEY]: JSON.stringify({ state: { radarTiltDeg: "steep" }, version: 0 }) });
  expect((await loadStore()).getState().radarTiltDeg).toBe(0);

  installLocalStorage();
  const store = await loadStore();
  expect(store.getState().radarTiltDeg).toBe(0);
  store.getState().setRadarTiltDeg(-10);
  expect(store.getState().radarTiltDeg).toBe(0);
  store.getState().setRadarTiltDeg(45);
  expect(store.getState().radarTiltDeg).toBe(45);
});
