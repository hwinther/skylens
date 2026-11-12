/**
 * Settings tab. The switches and steppers are the only way a user changes what the other screens do,
 * so the tests check what lands in settingsStore; the account section reflects (and ends) the
 * session; About only calls the authenticated /api/version while the API may be called, and
 * otherwise falls back to the anonymous /healthz.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import SettingsScreen from "../../app/settings";
import { clearTokens, getAccessTokenSync, setTokens } from "@/auth/tokenStore";
import { useAuthStore } from "@/state/authStore";
import { useSettingsStore } from "@/state/settingsStore";
import { resetClientLog } from "@/api/clientLog";
import { backendJson, resetStores, routeFetch } from "./fixtures";

const settings = () => useSettingsStore.getState();

async function renderSettings() {
  await render(<SettingsScreen />);
  await act(async () => {}); // let the About fetches settle
}

/** Open the collapsed About group (its title and its section's title are both "About"). */
async function openAbout() {
  await fireEvent.press(screen.getAllByText("About")[0]);
}

/** Backend requests other than the opportunistic /api/client-log flush. */
const apiCalls = (requested: string[]) => requested.filter((p) => p !== "/api/client-log");

describe("SettingsScreen", () => {
  beforeEach(async () => {
    resetStores();
    await clearTokens();
    resetClientLog();
    useSettingsStore.setState({ azimuthTrimDeg: 0, radiusKm: 60, polarisCalibrating: false });
    routeFetch({ "/healthz": () => backendJson({ status: "ok", version: "1.4.0" }) });
  });

  it("switches between demo and live", async () => {
    await renderSettings();
    expect(screen.getByText(/Demo replays recorded traffic/)).toBeOnTheScreen();

    await fireEvent(screen.getByTestId("settings-demo-mode"), "valueChange", false);

    expect(settings().demoMode).toBe(false);
    expect(screen.getByText(/Live: traffic, ships/)).toBeOnTheScreen();
  });

  it.each([
    ["settings-show-airports", "showAirports"],
    ["settings-show-small-airfields", "showSmallAirfields"],
    ["settings-show-ports", "showPorts"],
    ["settings-show-course-vectors", "showCourseVectors"],
    ["settings-show-fishing-zones", "showFishingZones"],
    ["settings-show-lost-gear", "showLostGear"],
    ["settings-show-satellites", "showSatellites"],
    ["settings-show-planets", "showPlanets"],
    ["settings-show-ecliptic", "showEcliptic"],
    ["settings-show-radio-sky", "showRadioSky"],
    ["settings-show-sky-events", "showSkyEvents"],
  ] as const)("%s toggles %s", async (testID, key) => {
    await renderSettings();
    const before = settings()[key];

    await fireEvent(screen.getByTestId(testID), "valueChange", !before);
    expect(settings()[key]).toBe(!before);
  });

  describe("account", () => {
    it("signed out behind auth: says so and offers a sign-in once the IdP is reachable", async () => {
      await renderSettings();
      expect(screen.getByText("Signed out")).toBeOnTheScreen();
      // IdP discovery still pending (setup.ts): the button waits for it.
      expect(screen.getByTestId("settings-signin")).toHaveTextContent("Loading…");
      expect(screen.getByTestId("settings-signin")).toBeDisabled();
      expect(screen.queryByTestId("settings-signout")).not.toBeOnTheScreen();
    });

    it("on a DevAuth server says no sign-in is needed", async () => {
      useAuthStore.setState({ authRequired: false });
      routeFetch({
        "/healthz": () => backendJson({ status: "ok", version: "1.4.0" }),
        "/api/version": () => backendJson({ version: "1.4.0", sha: "abcdef0123456789" }),
      });
      await renderSettings();
      expect(screen.getByText("Not needed on this server")).toBeOnTheScreen();
    });

    it("signed in: shows the user from /api/me and signs out", async () => {
      await setTokens({ accessToken: "tok", refreshToken: "r", idToken: null, expiresAt: Date.now() + 3_600_000 });
      useAuthStore.setState({ status: "authenticated" });
      routeFetch({
        "/api/me": () => backendJson({ sub: "u-1", preferredUsername: "hans" }),
        "/api/version": () => backendJson({ version: "1.4.0", sha: "abcdef0123456789" }),
      });
      await renderSettings();
      expect(screen.getByText("Signed in")).toBeOnTheScreen();
      expect(screen.getByText("hans")).toBeOnTheScreen();

      await fireEvent.press(screen.getByTestId("settings-signout"));

      expect(useAuthStore.getState().status).toBe("unauthenticated");
      expect(getAccessTokenSync()).toBeNull();
      expect(screen.getByTestId("settings-signin")).toBeOnTheScreen();
    });

    it("shows the last sign-in error while signed out", async () => {
      useAuthStore.setState({ lastError: "The sign-in window was blocked." });
      await renderSettings();
      expect(screen.getByTestId("settings-signin-error")).toHaveTextContent("The sign-in window was blocked.");
    });
  });

  describe("About: backend version", () => {
    it("uses only the anonymous /healthz while the API may not be called", async () => {
      const requested = routeFetch({ "/healthz": () => backendJson({ status: "ok", version: "1.4.0" }) });
      await renderSettings();
      await openAbout();

      expect(apiCalls(requested)).toEqual(["/healthz"]);
      expect(screen.getByText("1.4.0")).toBeOnTheScreen();
    });

    it("prefers /api/version (with the sha) when the API is open, and reveals the full sha on tap", async () => {
      useAuthStore.setState({ authRequired: false });
      const requested = routeFetch({
        "/api/version": () => backendJson({ version: "1.4.0", sha: "abcdef0123456789" }),
      });
      await renderSettings();
      await openAbout();

      expect(apiCalls(requested)).toEqual(["/api/version"]);
      await fireEvent.press(screen.getByText("1.4.0 · abcdef0"));
      expect(screen.getByText("1.4.0 · abcdef0123456789")).toBeOnTheScreen();
    });

    it("falls back to /healthz when /api/version fails", async () => {
      useAuthStore.setState({ authRequired: false });
      const requested = routeFetch({
        "/api/version": () => backendJson({ error: "boom" }, 500),
        "/healthz": () => backendJson({ status: "ok", version: "1.4.0" }),
      });
      await renderSettings();
      await openAbout();
      expect(apiCalls(requested)).toEqual(["/api/version", "/healthz"]);
      expect(screen.getByText("1.4.0")).toBeOnTheScreen();
    });

    it("says unavailable when the backend can't be reached", async () => {
      routeFetch({});
      await renderSettings();
      await openAbout();
      expect(screen.getByText("unavailable")).toBeOnTheScreen();
    });
  });

  describe("calibration", () => {
    async function openCalibration() {
      await renderSettings();
      await fireEvent.press(screen.getByText("Calibration & sensors"));
    }

    it("steps the azimuth trim while + is held, and stops on release", async () => {
      jest.useFakeTimers();
      try {
        await openCalibration();
        const trimPlus = screen.getByTestId("settings-azimuth-trim-inc");

        await fireEvent(trimPlus, "pressIn");
        expect(settings().azimuthTrimDeg).toBe(1); // a plain tap steps once
        await act(async () => jest.advanceTimersByTime(360));
        expect(settings().azimuthTrimDeg).toBe(4); // then every 120 ms
        await fireEvent(trimPlus, "pressOut");
        await act(async () => jest.advanceTimersByTime(1_000));
        expect(settings().azimuthTrimDeg).toBe(4);
      } finally {
        jest.useRealTimers();
      }
    });

    it("stops repeating at the bound", async () => {
      jest.useFakeTimers();
      try {
        useSettingsStore.setState({ azimuthTrimDeg: 43 });
        await openCalibration();
        const trimPlus = screen.getByTestId("settings-azimuth-trim-inc");

        await fireEvent(trimPlus, "pressIn");
        await act(async () => jest.advanceTimersByTime(2_000));
        expect(settings().azimuthTrimDeg).toBe(45);
      } finally {
        jest.useRealTimers();
      }
    });

    it("sets the radius from a preset", async () => {
      await openCalibration();
      await fireEvent.press(screen.getByText("250"));
      expect(settings().radiusKm).toBe(250);
    });

    it("arms Polaris calibration and goes to the AR view", async () => {
      await openCalibration();
      await fireEvent.press(screen.getByTestId("settings-polaris-calibrate"));
      expect(settings().polarisCalibrating).toBe(true);
      expect(router.push).toHaveBeenCalledWith("/");
    });
  });
});
