/**
 * The sign-in surfaces: the floating SignInPrompt card (live mode, backend wants a sign-in, no
 * session), the ApiIssueBanner that shares its spot, and the /sign-in screen. useAuth runs for real
 * against the mocked expo-auth-session (setup.ts: discovery pending, no request); mock-auth mode is
 * used where a test needs a sign-in to succeed.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { router, usePathname } from "expo-router";
import { SignInPrompt } from "@/components/SignInPrompt";
import { ApiIssueBanner } from "@/components/ApiIssueBanner";
import SignInScreen from "../../app/sign-in";
import { clearTokens } from "@/auth/tokenStore";
import { useApiIssueStore } from "@/state/apiIssueStore";
import { useAuthStore } from "@/state/authStore";
import { useSettingsStore } from "@/state/settingsStore";
import { resetStores } from "./fixtures";

const pathname = jest.mocked(usePathname);

function goLive() {
  useSettingsStore.setState({ demoMode: false });
}

describe("SignInPrompt", () => {
  beforeEach(async () => {
    resetStores();
    await clearTokens();
  });

  it("shows in live mode when the backend wants a sign-in and there is no session", async () => {
    goLive();
    await render(<SignInPrompt />);
    expect(screen.getByTestId("signin-prompt")).toBeOnTheScreen();
  });

  it.each([
    ["demo mode", () => useSettingsStore.setState({ demoMode: true })],
    ["a DevAuth backend", () => useAuthStore.setState({ authRequired: false })],
    ["a session", () => useAuthStore.setState({ status: "authenticated" })],
    ["the auth probe still unanswered", () => useAuthStore.setState({ authRequired: null })],
  ])("stays hidden with %s", async (_name, arrange) => {
    goLive();
    arrange();
    await render(<SignInPrompt />);
    expect(screen.queryByTestId("signin-prompt")).not.toBeOnTheScreen();
  });

  it.each(["/sign-in", "/oauth", "/onboarding"])("stays out of the way on %s", async (route) => {
    goLive();
    pathname.mockReturnValue(route);
    await render(<SignInPrompt />);
    expect(screen.queryByTestId("signin-prompt")).not.toBeOnTheScreen();
  });

  it("goes back to demo mode on Continue in demo", async () => {
    goLive();
    await render(<SignInPrompt />);

    await fireEvent.press(screen.getByTestId("signin-prompt-demo"));

    expect(useSettingsStore.getState().demoMode).toBe(true);
    expect(screen.queryByTestId("signin-prompt")).not.toBeOnTheScreen();
  });

  it("waits for the sign-in service before allowing a press, and shows the last error", async () => {
    goLive();
    useAuthStore.setState({ lastError: "Sign-in failed (invalid_grant). Try again." });
    await render(<SignInPrompt />);

    expect(screen.getByTestId("signin-prompt-signin")).toBeDisabled();
    expect(screen.getByTestId("signin-prompt-signin")).toHaveTextContent("Loading…");
    expect(screen.getByTestId("signin-prompt-error")).toHaveTextContent(/invalid_grant/);
  });

  it("disappears once the sign-in succeeds", async () => {
    goLive();
    useAuthStore.setState({ mockMode: true });
    await render(<SignInPrompt />);

    await fireEvent.press(screen.getByTestId("signin-prompt-signin"));

    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(screen.queryByTestId("signin-prompt")).not.toBeOnTheScreen();
  });
});

describe("ApiIssueBanner", () => {
  beforeEach(() => {
    resetStores();
    useApiIssueStore.setState({ issue: null, mutedUntil: {} });
  });

  const report = (path: string, status: number | null, reached = true) =>
    act(async () => useApiIssueStore.getState().report(path, status, reached));

  it("shows the latest failure and hides that kind for a while once dismissed", async () => {
    await render(<ApiIssueBanner />);
    expect(screen.queryByTestId("api-issue-banner")).not.toBeOnTheScreen();

    await report("/api/ports?lat=1", 503);
    expect(screen.getByTestId("api-issue-text")).toHaveTextContent("Server error loading ports (503).");
    expect(screen.queryByTestId("api-issue-signin")).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("api-issue-dismiss"));
    expect(screen.queryByTestId("api-issue-banner")).not.toBeOnTheScreen();

    // Muted: the same layer failing again on its next refetch doesn't bring it straight back.
    await report("/api/ports", 503);
    expect(screen.queryByTestId("api-issue-banner")).not.toBeOnTheScreen();
  });

  it("offers a sign-in for an expired session", async () => {
    useAuthStore.setState({ authRequired: true, status: "unauthenticated" });
    await render(<ApiIssueBanner />);
    await report("/api/airports", 401);

    // Demo mode, so the sign-in card is not up and the banner speaks for the 401.
    expect(screen.getByTestId("api-issue-text")).toHaveTextContent("Sign in to load airports (401).");
    await fireEvent.press(screen.getByTestId("api-issue-signin"));

    expect(router.push).toHaveBeenCalledWith("/sign-in");
    expect(useApiIssueStore.getState().issue).toBeNull();
  });

  it("steps aside for an auth issue while the sign-in card is up, but not for other issues", async () => {
    goLive();
    await render(
      <>
        <ApiIssueBanner />
        <SignInPrompt />
      </>,
    );
    await report("/api/airports", 401);
    expect(screen.getByTestId("signin-prompt")).toBeOnTheScreen();
    expect(screen.queryByTestId("api-issue-banner")).not.toBeOnTheScreen();

    await report("/api/airports", null);
    expect(screen.getByTestId("api-issue-text")).toHaveTextContent(/couldn't reach the server/i);
  });
});

describe("SignInScreen", () => {
  beforeEach(async () => {
    resetStores();
    await clearTokens();
  });

  it("goes back where the user came from once signed in", async () => {
    useAuthStore.setState({ mockMode: true });
    jest.mocked(router.canGoBack).mockReturnValue(true);
    await render(<SignInScreen />);
    expect(screen.getByTestId("signin-screen-signin")).toHaveTextContent("Continue (mock)");

    await fireEvent.press(screen.getByTestId("signin-screen-signin"));

    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(router.back).toHaveBeenCalled();
  });

  it("switches to demo and leaves to the AR view when there is nothing to go back to", async () => {
    useSettingsStore.setState({ demoMode: false });
    await render(<SignInScreen />);

    await fireEvent.press(screen.getByTestId("signin-screen-demo"));

    expect(useSettingsStore.getState().demoMode).toBe(true);
    expect(router.replace).toHaveBeenCalledWith("/");
  });

  it("shows why the last attempt failed", async () => {
    useAuthStore.setState({ lastError: "The sign-in window was blocked." });
    await render(<SignInScreen />);
    expect(screen.getByTestId("signin-screen-error")).toHaveTextContent("The sign-in window was blocked.");
    expect(screen.getByTestId("signin-screen-signin")).toBeDisabled();
  });
});
