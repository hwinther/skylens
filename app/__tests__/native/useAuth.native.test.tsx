/**
 * useAuth: the PKCE sign-in against the IdP. expo-auth-session is mocked at the module edge (setup.ts
 * resets its defaults); the token store and authStore are real, so the tests check what a sign-in
 * leaves behind: the session status, the stored access token the API client and hub read, and the
 * user-facing lastError the sign-in screens show.
 */
import { act, renderHook } from "@testing-library/react-native";
import * as AuthSession from "expo-auth-session";
import { useAuth } from "@/auth/useAuth";
import { clearTokens, getAccessTokenSync, getTokensSync, setTokens } from "@/auth/tokenStore";
import { useAuthStore } from "@/state/authStore";

const auth = jest.mocked(AuthSession);

const DISCOVERY = {
  authorizationEndpoint: "https://idp.test/authorize",
  tokenEndpoint: "https://idp.test/token",
} as AuthSession.DiscoveryDocument;

type PromptResult = Awaited<ReturnType<ReturnType<typeof AuthSession.useAuthRequest>[2]>>;

/** Discovery loads, the PKCE request is built (only once discovery is there), and the popup answers `prompt`. */
function idpAnswers(prompt: () => Promise<PromptResult>) {
  const promptAsync = jest.fn(prompt);
  auth.fetchDiscoveryAsync.mockResolvedValue(DISCOVERY);
  auth.useAuthRequest.mockImplementation((_config, discovery) => [
    discovery ? ({ codeVerifier: "verifier-123" } as AuthSession.AuthRequest) : null,
    null,
    promptAsync,
  ]);
  return promptAsync;
}

const success = { type: "success", params: { code: "code-xyz" } } as unknown as PromptResult;

async function renderAuth() {
  return renderHook(() => useAuth());
}

const store = () => useAuthStore.getState();

describe("useAuth", () => {
  beforeEach(async () => {
    await clearTokens();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("exchanges the code with the PKCE verifier and stores the session", async () => {
    const promptAsync = idpAnswers(() => Promise.resolve(success));
    auth.exchangeCodeAsync.mockResolvedValue({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresIn: 600,
    } as AuthSession.TokenResponse);
    const { result } = await renderAuth();
    expect(result.current.ready).toBe(true);
    expect(result.current.loading).toBe(false);

    await act(() => result.current.signIn());

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const [exchange] = auth.exchangeCodeAsync.mock.calls[0];
    expect(exchange).toMatchObject({
      code: "code-xyz",
      clientId: "skylens",
      extraParams: { code_verifier: "verifier-123" },
    });
    expect(store().status).toBe("authenticated");
    expect(store().lastError).toBeNull();
    expect(getAccessTokenSync()).toBe("access-1");
    expect(getTokensSync()?.refreshToken).toBe("refresh-1");
  });

  it("returns to signed out without an error when the user closes the popup", async () => {
    idpAnswers(() => Promise.resolve({ type: "dismiss" } as PromptResult));
    const { result } = await renderAuth();

    await act(() => result.current.signIn());

    expect(store().status).toBe("unauthenticated");
    expect(store().lastError).toBeNull();
    expect(auth.exchangeCodeAsync).not.toHaveBeenCalled();
  });

  it("explains a blocked popup", async () => {
    idpAnswers(() => Promise.reject(Object.assign(new Error("blocked"), { code: "ERR_WEB_BROWSER_BLOCKED" })));
    const { result } = await renderAuth();

    await act(() => result.current.signIn());

    expect(store().status).toBe("unauthenticated");
    expect(store().lastError).toMatch(/window was blocked.*allow pop-ups/i);
  });

  it("reports an error answer from the IdP", async () => {
    idpAnswers(() =>
      Promise.resolve({ type: "error", error: new Error("access_denied") } as unknown as PromptResult),
    );
    const { result } = await renderAuth();

    await act(() => result.current.signIn());

    expect(store().status).toBe("unauthenticated");
    expect(store().lastError).toBe("Sign-in failed (access_denied). Try again.");
  });

  it("leaves no session when the code exchange fails", async () => {
    idpAnswers(() => Promise.resolve(success));
    auth.exchangeCodeAsync.mockRejectedValue(new Error("invalid_grant"));
    const { result } = await renderAuth();

    await act(() => result.current.signIn());

    expect(store().status).toBe("unauthenticated");
    expect(store().lastError).toBe("Sign-in failed (invalid_grant). Try again.");
    expect(getAccessTokenSync()).toBeNull();
  });

  it("asks the user to wait while the IdP discovery is still loading", async () => {
    // setup.ts default: discovery never settles, no request.
    const { result } = await renderAuth();
    expect(result.current.ready).toBe(false);
    expect(result.current.loading).toBe(true);

    await act(() => result.current.signIn());

    expect(store().lastError).toBe("Sign-in is still loading. Try again in a moment.");
    expect(store().status).toBe("unauthenticated");
  });

  it("says the IdP is unreachable when discovery failed, and fetches it again for the next try", async () => {
    auth.fetchDiscoveryAsync.mockRejectedValueOnce(new SyntaxError("JSON Parse error"));
    const { result } = await renderAuth();
    expect(result.current.loading).toBe(false);
    expect(auth.fetchDiscoveryAsync).toHaveBeenCalledTimes(1);

    await act(() => result.current.signIn());

    expect(store().lastError).toMatch(/couldn't reach the sign-in service/i);
    expect(auth.fetchDiscoveryAsync).toHaveBeenCalledTimes(2);
  });

  it("mints a mock session without touching the IdP in mock mode", async () => {
    useAuthStore.setState({ mockMode: true });
    const { result } = await renderAuth();
    expect(result.current.ready).toBe(true);

    await act(() => result.current.signIn());

    expect(auth.fetchDiscoveryAsync).not.toHaveBeenCalled();
    expect(store().status).toBe("authenticated");
    expect(getTokensSync()?.mock).toBe(true);
  });

  it("signs out: clears the stored tokens and the last error", async () => {
    await setTokens({ accessToken: "a", refreshToken: "r", idToken: null, expiresAt: Date.now() + 60_000 });
    useAuthStore.setState({ status: "authenticated", lastError: "old" });
    const { result } = await renderAuth();

    await act(() => result.current.signOut());

    expect(getAccessTokenSync()).toBeNull();
    expect(store().status).toBe("unauthenticated");
    expect(store().lastError).toBeNull();
  });
});
