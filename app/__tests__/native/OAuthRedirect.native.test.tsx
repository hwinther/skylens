/**
 * The /oauth route on Android. promptAsync completes a sign-in on its own; the OS also delivers the
 * `skylens://oauth?code=…` redirect as a deep link, which lands here and must just go home. When no
 * sign-in is waiting for it (Android stopped the app while the browser was open, so the PKCE verifier
 * is gone), the route says so instead of leaving the user signed out without a word.
 */
import { act, render, renderHook } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as AuthSession from "expo-auth-session";
import OAuthRedirectScreen from "../../app/oauth";
import { useAuth } from "@/auth/useAuth";
import { clearTokens } from "@/auth/tokenStore";
import { useAuthStore } from "@/state/authStore";

const params = jest.mocked(useLocalSearchParams);
const INTERRUPTED = "Sign-in didn't finish because the app was restarted. Try again.";

describe("OAuth redirect route (native)", () => {
  beforeEach(async () => {
    await clearTokens();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("goes home without a message when opened with no redirect parameters", async () => {
    await render(<OAuthRedirectScreen />);

    expect(router.replace).toHaveBeenCalledWith("/");
    expect(useAuthStore.getState().lastError).toBeNull();
  });

  it("explains a redirect that arrives after the app was restarted", async () => {
    // Cold start: the session is not even hydrated yet, and no sign-in is in flight.
    useAuthStore.setState({ status: "unknown" });
    params.mockReturnValue({ code: "fake-code", state: "fake-state" });

    await render(<OAuthRedirectScreen />);

    expect(router.replace).toHaveBeenCalledWith("/");
    expect(useAuthStore.getState().lastError).toBe(INTERRUPTED);
    expect(AuthSession.exchangeCodeAsync).not.toHaveBeenCalled();
  });

  it("explains an IdP error redirect that nothing is waiting for", async () => {
    params.mockReturnValue({ error: "access_denied", state: "fake-state" });

    await render(<OAuthRedirectScreen />);

    expect(useAuthStore.getState().lastError).toBe(INTERRUPTED);
  });

  it("stays quiet once signed in", async () => {
    useAuthStore.setState({ status: "authenticated" });
    params.mockReturnValue({ code: "fake-code", state: "fake-state" });

    await render(<OAuthRedirectScreen />);

    expect(useAuthStore.getState().lastError).toBeNull();
  });

  // Last: the never-settling sign-in leaves this module's in-flight flag set.
  it("stays quiet while the sign-in that opened the browser is still completing", async () => {
    const auth = jest.mocked(AuthSession);
    auth.fetchDiscoveryAsync.mockResolvedValue({
      authorizationEndpoint: "https://idp.test/authorize",
      tokenEndpoint: "https://idp.test/token",
    } as AuthSession.DiscoveryDocument);
    // The browser is open: promptAsync has not resolved yet.
    auth.AuthRequest.mockImplementation(
      () =>
        ({
          codeVerifier: "verifier-fake",
          makeAuthUrlAsync: () => Promise.resolve("https://idp.test/authorize"),
          promptAsync: () => new Promise(() => {}),
        }) as unknown as AuthSession.AuthRequest,
    );
    const { result } = await renderHook(() => useAuth());
    await act(async () => {});
    await act(async () => {
      void result.current.signIn();
    });
    expect(useAuthStore.getState().status).toBe("authenticating");

    params.mockReturnValue({ code: "fake-code", state: "fake-state" });
    await render(<OAuthRedirectScreen />);

    expect(router.replace).toHaveBeenCalledWith("/");
    expect(useAuthStore.getState().lastError).toBeNull();
  });
});
