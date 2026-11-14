/**
 * How sign-in and refresh failures are classified and worded (src/auth/errors), shared by web and
 * native. The key rule: only an OAuth rejection from the IdP ends a session; no answer, or a
 * non-OAuth one, keeps it.
 */
import {
  IDP_UNREACHABLE_MESSAGE,
  isNetworkFailure,
  isSessionEndingRefreshError,
  oauthErrorCode,
  signInErrorMessage,
} from "@/auth/errors";

const coded = (code: string, message = "some long provider text") => Object.assign(new Error(message), { code });

describe("oauthErrorCode", () => {
  it("reads the lower_snake OAuth code of a TokenError/AuthError", () => {
    expect(oauthErrorCode(coded("invalid_grant"))).toBe("invalid_grant");
    expect(oauthErrorCode(coded("state_mismatch"))).toBe("state_mismatch");
  });

  it("ignores expo's own ERR_ codes and errors without a code", () => {
    expect(oauthErrorCode(coded("ERR_WEB_BROWSER_BLOCKED"))).toBeNull();
    expect(oauthErrorCode(new Error("invalid_grant"))).toBeNull();
    expect(oauthErrorCode(null)).toBeNull();
  });
});

describe("isSessionEndingRefreshError", () => {
  it.each(["invalid_grant", "invalid_client", "unauthorized_client", "invalid_request"])("ends on %s", (code) => {
    expect(isSessionEndingRefreshError(coded(code))).toBe(true);
  });

  it.each([
    ["a network failure", new TypeError("Network request failed")],
    ["a JSON parse error from an HTML error page", new SyntaxError("Unexpected token <")],
    ["server_error", coded("server_error")],
    ["temporarily_unavailable", coded("temporarily_unavailable")],
    ["an expo error", coded("ERR_UNEXPECTED")],
  ])("keeps the session on %s", (_name, err) => {
    expect(isSessionEndingRefreshError(err)).toBe(false);
  });
});

describe("isNetworkFailure", () => {
  it.each(["Network request failed", "Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."])(
    "recognises %s",
    (message) => expect(isNetworkFailure(new TypeError(message))).toBe(true),
  );

  it("does not take other errors for one", () => {
    expect(isNetworkFailure(new TypeError("x is not a function"))).toBe(false);
    expect(isNetworkFailure(new Error("Network request failed"))).toBe(false);
  });
});

describe("signInErrorMessage", () => {
  it("explains a blocked popup (web)", () => {
    expect(signInErrorMessage(coded("ERR_WEB_BROWSER_BLOCKED"))).toMatch(/allow pop-ups/i);
  });

  it("explains a phone without a browser (Android)", () => {
    expect(signInErrorMessage(coded("ERR_NO_MATCHING_ACTIVITY", "No matching browser activity found"))).toMatch(
      /no web browser is available/i,
    );
    expect(signInErrorMessage(new Error("No matching browser activity found"))).toMatch(/no web browser/i);
  });

  it("says the sign-in service is unreachable for a network failure", () => {
    expect(signInErrorMessage(new TypeError("Network request failed"))).toBe(IDP_UNREACHABLE_MESSAGE);
  });

  it("names the OAuth code instead of the provider's paragraph", () => {
    expect(signInErrorMessage(coded("invalid_grant"))).toBe("Sign-in failed (invalid_grant). Try again.");
  });

  it("falls back to the error's message", () => {
    expect(signInErrorMessage(new Error("access_denied"))).toBe("Sign-in failed (access_denied). Try again.");
    expect(signInErrorMessage("weird")).toBe("Sign-in failed. Try again.");
  });
});
