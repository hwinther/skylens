/**
 * useAuth: the PKCE sign-in against the IdP. expo-auth-session is mocked at the module edge (setup.ts
 * resets its defaults); the token store and authStore are real, so the tests check what a sign-in
 * leaves behind: the session status, the stored access token the API client and hub read, and the
 * user-facing lastError the sign-in screens show.
 *
 * On Android promptAsync opens a Custom Tab and resolves with the `skylens://oauth` redirect
 * ("success"), "dismiss" when the user closes the tab, or "error" for an IdP error answer or a
 * redirect whose state doesn't match. Those outcomes are what these tests feed in.
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

type PromptResult = Awaited<ReturnType<AuthSession.AuthRequest["promptAsync"]>>;

interface FakeRequest {
  state: string;
  codeVerifier: string;
  makeAuthUrlAsync: jest.Mock;
  promptAsync: jest.Mock;
}

/**
 * Discovery loads, and every PKCE request useAuth builds gets its own state and verifier and answers
 * `prompt`. Returns the requests in the order they were built.
 */
function idpAnswers(prompt: () => Promise<PromptResult>): FakeRequest[] {
  const built: FakeRequest[] = [];
  auth.fetchDiscoveryAsync.mockResolvedValue(DISCOVERY);
  auth.AuthRequest.mockImplementation(() => {
    const n = built.length + 1;
    const request: FakeRequest = {
      state: `state-${n}`,
      codeVerifier: `verifier-${n}`,
      makeAuthUrlAsync: jest.fn(() => Promise.resolve(`https://idp.test/authorize?state=state-${n}`)),
      promptAsync: jest.fn(prompt),
    };
    built.push(request);
    return request as unknown as AuthSession.AuthRequest;
  });
  return built;
}

const success = { type: "success", params: { code: "code-xyz", state: "state-1" } } as unknown as PromptResult;

/** An OAuth error answer as expo-auth-session throws it (TokenError / AuthError carry the code). */
function oauthError(code: string): Error {
  return Object.assign(new Error(`The provider says: ${code} (long RFC text)`), { code });
}

async function renderAuth() {
  const hook = await renderHook(() => useAuth());
  // Let discovery and the request's URL settle.
  await act(async () => {});
  return hook;
}

const store = () => useAuthStore.getState();

describe("useAuth", () => {
  beforeEach(async () => {
    await clearTokens();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("exchanges the code with the PKCE verifier and stores the session", async () => {
    const requests = idpAnswers(() => Promise.resolve(success));
    auth.exchangeCodeAsync.mockResolvedValue({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresIn: 600,
    } as AuthSession.TokenResponse);
    const { result } = await renderAuth();
    expect(result.current.ready).toBe(true);
    expect(result.current.loading).toBe(false);

    await act(() => result.current.signIn());

    expect(requests[0].promptAsync).toHaveBeenCalledTimes(1);
    expect(requests[0].promptAsync).toHaveBeenCalledWith(DISCOVERY, expect.anything());
    const [requestConfig] = auth.AuthRequest.mock.calls[0];
    expect(requestConfig).toMatchObject({
      clientId: "skylens",
      redirectUri: "skylens://oauth",
      usePKCE: true,
      extraParams: { audience: "skylens-api" },
    });
    const [exchange] = auth.exchangeCodeAsync.mock.calls[0];
    expect(exchange).toMatchObject({
      code: "code-xyz",
      clientId: "skylens",
      redirectUri: "skylens://oauth",
      extraParams: { code_verifier: "verifier-1" },
    });
    expect(store().status).toBe("authenticated");
    expect(store().lastError).toBeNull();
    expect(getAccessTokenSync()).toBe("access-1");
    expect(getTokensSync()?.refreshToken).toBe("refresh-1");
  });

  it("uses a new state and code verifier for every attempt", async () => {
    const requests = idpAnswers(() => Promise.resolve({ type: "dismiss" } as PromptResult));
    const { result } = await renderAuth();

    await act(() => result.current.signIn());
    await act(async () => {});
    expect(result.current.ready).toBe(true);

    // The second attempt succeeds, with the second request's verifier.
    requests[1]?.promptAsync.mockResolvedValue(success);
    auth.exchangeCodeAsync.mockResolvedValue({ accessToken: "access-2", expiresIn: 600 } as AuthSession.TokenResponse);
    await act(() => result.current.signIn());

    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[0].promptAsync).toHaveBeenCalledTimes(1);
    expect(requests[1].promptAsync).toHaveBeenCalledTimes(1);
    expect(requests[1].state).not.toBe(requests[0].state);
    expect(auth.exchangeCodeAsync.mock.calls[0][0]).toMatchObject({ extraParams: { code_verifier: "verifier-2" } });
    expect(store().status).toBe("authenticated");
  });

  it("returns to signed out without an error when the user closes the browser", async () => {
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

  it("explains a phone with no browser to sign in with", async () => {
    idpAnswers(() =>
      Promise.reject(Object.assign(new Error("No matching browser activity found"), { code: "ERR_NO_MATCHING_ACTIVITY" })),
    );
    const { result } = await renderAuth();

    await act(() => result.current.signIn());

    expect(store().status).toBe("unauthenticated");
    expect(store().lastError).toMatch(/no web browser is available/i);
  });

  it("reports an error answer from the IdP by its code", async () => {
    idpAnswers(() => Promise.resolve({ type: "error", error: oauthError("access_denied") } as unknown as PromptResult));
    const { result } = await renderAuth();

    await act(() => result.current.signIn());

    expect(store().status).toBe("unauthenticated");
    expect(store().lastError).toBe("Sign-in failed (access_denied). Try again.");
    expect(auth.exchangeCodeAsync).not.toHaveBeenCalled();
  });

  it("rejects a redirect whose state doesn't match", async () => {
    idpAnswers(() => Promise.resolve({ type: "error", error: oauthError("state_mismatch") } as unknown as PromptResult));
    const { result } = await renderAuth();

    await act(() => result.current.signIn());

    expect(store().lastError).toBe("Sign-in failed (state_mismatch). Try again.");
    expect(auth.exchangeCodeAsync).not.toHaveBeenCalled();
    expect(getAccessTokenSync()).toBeNull();
  });

  it("leaves no session when the code exchange is rejected", async () => {
    idpAnswers(() => Promise.resolve(success));
    auth.exchangeCodeAsync.mockRejectedValue(oauthError("invalid_grant"));
    const { result } = await renderAuth();

    await act(() => result.current.signIn());

    expect(store().status).toBe("unauthenticated");
    expect(store().lastError).toBe("Sign-in failed (invalid_grant). Try again.");
    expect(getAccessTokenSync()).toBeNull();
  });

  it("says the sign-in service is unreachable when the exchange gets no answer", async () => {
    idpAnswers(() => Promise.resolve(success));
    auth.exchangeCodeAsync.mockRejectedValue(new TypeError("Network request failed"));
    const { result } = await renderAuth();

    await act(() => result.current.signIn());

    expect(store().status).toBe("unauthenticated");
    expect(store().lastError).toMatch(/couldn't reach the sign-in service/i);
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
    expect(getTokensSync()).toBeNull();
    expect(store().status).toBe("unauthenticated");
    expect(store().lastError).toBeNull();
    // Gone from SecureStore too, so a restart stays signed out.
    const secure = jest.requireMock<{ __data: Map<string, string> }>("expo-secure-store").__data;
    expect(secure.has("skylens.tokens.v1")).toBe(false);
  });
});
