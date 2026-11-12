/**
 * Root layout gating. At startup it probes an anonymous GET /api/me (200 under DevAuth, 401 behind
 * real auth, anything else: ask again in 5 s), restores a persisted session, routes a fresh install
 * to onboarding, and only opens the live hub when the API may be called. In live mode behind auth
 * with no session the sign-in card shows instead.
 *
 * The tab navigator is a no-op mock (setup.ts) and the hub factory is mocked at src/api/signalr.ts;
 * the probe, token store, stores, useLiveFeed and SignInPrompt run for real.
 */
import { act, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import RootLayout from "../../app/_layout";
import { createAircraftHubConnection } from "@/api/signalr";
import { clearTokens, setTokens } from "@/auth/tokenStore";
import { useAuthStore } from "@/state/authStore";
import { useSettingsStore } from "@/state/settingsStore";
import { resetStores } from "./fixtures";
import { FakeHub } from "./fakeHub";

jest.mock("@/api/signalr", () => ({
  ...jest.requireActual<object>("@/api/signalr"),
  createAircraftHubConnection: jest.fn(),
}));
const createHub = jest.mocked(createAircraftHubConnection);

/** Answer GET /api/me with `status` (a number), or fail it (null = network error). */
function meAnswers(...statuses: (number | null)[]) {
  const fetchMock = jest.mocked(globalThis.fetch);
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    if (!url.endsWith("/api/me")) return Promise.reject(new Error(`unexpected fetch ${url}`));
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
    return status == null
      ? Promise.reject(new TypeError("Network request failed"))
      : Promise.resolve({ status } as Response);
  });
  return () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/api/me")).length;
}

async function renderLayout() {
  await render(<RootLayout />);
  // Let the async startup work (token hydration, probe) settle.
  await act(async () => {});
}

describe("RootLayout", () => {
  beforeEach(async () => {
    resetStores();
    await clearTokens();
    useAuthStore.setState({ status: "unknown", authRequired: null });
    // A returning user, so the onboarding redirect stays out of the way unless a test wants it.
    useSettingsStore.setState({ _hydrated: true, onboarded: true });
    createHub.mockImplementation(() => new FakeHub().asConnection());
  });

  it("behind real auth (401) shows the sign-in card in live mode and opens no hub", async () => {
    meAnswers(401);
    useSettingsStore.setState({ demoMode: false });
    await renderLayout();

    expect(useAuthStore.getState()).toMatchObject({ authRequired: true, status: "unauthenticated" });
    expect(screen.getByTestId("signin-prompt")).toBeOnTheScreen();
    expect(createHub).not.toHaveBeenCalled();
  });

  it("under DevAuth (200) needs no sign-in and connects the live hub", async () => {
    meAnswers(200);
    useSettingsStore.setState({ demoMode: false });
    await renderLayout();

    expect(useAuthStore.getState().authRequired).toBe(false);
    expect(screen.queryByTestId("signin-prompt")).not.toBeOnTheScreen();
    expect(createHub).toHaveBeenCalledTimes(1);
  });

  it("opens no hub in demo mode, even when the API is open", async () => {
    meAnswers(200);
    await renderLayout();

    expect(useAuthStore.getState().authRequired).toBe(false);
    expect(createHub).not.toHaveBeenCalled();
  });

  it("connects behind real auth once a persisted session is restored", async () => {
    await setTokens({ accessToken: "a", refreshToken: "r", idToken: null, expiresAt: Date.now() + 3_600_000 });
    meAnswers(401);
    useSettingsStore.setState({ demoMode: false });
    await renderLayout();

    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(screen.queryByTestId("signin-prompt")).not.toBeOnTheScreen();
    expect(createHub).toHaveBeenCalled();
  });

  it("asks again every 5 s while the probe gets no answer, and stays gated meanwhile", async () => {
    jest.useFakeTimers();
    try {
      const probes = meAnswers(null, 503, 401);
      useSettingsStore.setState({ demoMode: false });
      await renderLayout();
      expect(probes()).toBe(1);
      expect(useAuthStore.getState().authRequired).toBeNull();
      // Unknown is not "open": no hub, and no sign-in card yet either.
      expect(createHub).not.toHaveBeenCalled();
      expect(screen.queryByTestId("signin-prompt")).not.toBeOnTheScreen();

      await act(async () => jest.advanceTimersByTime(5_000));
      expect(probes()).toBe(2);
      expect(useAuthStore.getState().authRequired).toBeNull();

      await act(async () => jest.advanceTimersByTime(5_000));
      expect(probes()).toBe(3);
      expect(useAuthStore.getState().authRequired).toBe(true);
      expect(screen.getByTestId("signin-prompt")).toBeOnTheScreen();

      // Answered: no more probing.
      await act(async () => jest.advanceTimersByTime(30_000));
      expect(probes()).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it("routes a fresh install to onboarding once settings have hydrated", async () => {
    meAnswers(401);
    useSettingsStore.setState({ _hydrated: false, onboarded: false });
    await renderLayout();
    // Not before hydration: a returning user must never see the intro flash.
    expect(router.replace).not.toHaveBeenCalledWith("/onboarding");

    await act(async () => useSettingsStore.setState({ _hydrated: true }));
    expect(router.replace).toHaveBeenCalledWith("/onboarding");
  });

  it("leaves a returning user where they are", async () => {
    meAnswers(401);
    await renderLayout();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
