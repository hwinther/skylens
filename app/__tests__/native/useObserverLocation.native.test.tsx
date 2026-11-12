/**
 * useObserverLocation: the live observer the hub subscription is centred on. Baked home coordinates
 * win (dev / source-mode e2e); otherwise one geolocation fix; denied or failing geolocation leaves it
 * null (the hub then stays unsubscribed rather than centring on a wrong place).
 */
import { act, renderHook } from "@testing-library/react-native";
import * as Location from "expo-location";
import { useObserverLocation } from "@/components/useObserverLocation";

const location = jest.mocked(Location);
const ENV_KEYS = ["EXPO_PUBLIC_HOME_LAT", "EXPO_PUBLIC_HOME_LON", "EXPO_PUBLIC_HOME_ALT"] as const;

async function renderObserver(enabled = true) {
  const hook = await renderHook((on: boolean) => useObserverLocation(on), { initialProps: enabled });
  await act(async () => {}); // permission request + fix are async
  return hook;
}

function grant() {
  location.requestForegroundPermissionsAsync.mockResolvedValueOnce({
    status: "granted",
    granted: true,
  } as Awaited<ReturnType<typeof Location.requestForegroundPermissionsAsync>>);
}

describe("useObserverLocation", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("uses the baked home coordinates without asking for location", async () => {
    process.env.EXPO_PUBLIC_HOME_LAT = "59.91";
    process.env.EXPO_PUBLIC_HOME_LON = "10.75";
    process.env.EXPO_PUBLIC_HOME_ALT = "120";
    const { result } = await renderObserver();

    expect(result.current).toEqual({ lat: 59.91, lon: 10.75, alt: 120 });
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it("falls back to one device fix when no home is baked", async () => {
    grant();
    location.getCurrentPositionAsync.mockResolvedValueOnce({
      coords: { latitude: 63.4, longitude: 10.4, altitude: null, accuracy: 5 },
      timestamp: 0,
    } as unknown as Location.LocationObject);
    const { result } = await renderObserver();

    expect(result.current).toEqual({ lat: 63.4, lon: 10.4 });
  });

  it("stays null when location is denied or the fix fails", async () => {
    const denied = await renderObserver();
    expect(denied.result.current).toBeNull();
    expect(location.getCurrentPositionAsync).not.toHaveBeenCalled();

    grant(); // setup.ts: getCurrentPositionAsync rejects
    const failed = await renderObserver();
    expect(failed.result.current).toBeNull();
  });

  it("asks for nothing while disabled (demo mode)", async () => {
    const { result } = await renderObserver(false);
    expect(result.current).toBeNull();
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
});
