/**
 * How a failed sign-in or refresh is classified and worded. Shared by web and native (the same
 * expo-auth-session errors reach both), pure TS so it is unit-testable.
 *
 * The distinction that matters most: an OAuth error answer from the IdP (`invalid_grant` for a
 * revoked or expired refresh token) means the session is really over, while a network failure
 * (offline, captive portal, an app resumed before the radio is back) or a non-OAuth answer (a proxy's
 * 502 page) says nothing about the session, which must survive it.
 */

/** The user-facing reason shown after the IdP ended the session (refresh token rejected or missing). */
export const SESSION_ENDED_MESSAGE = "Your session has ended. Sign in again.";

/**
 * Shown when the app receives the IdP's redirect with no sign-in waiting for it: Android stopped the
 * app while the browser was open (or the redirect came after the browser was closed), so the PKCE
 * verifier that would complete it is gone.
 */
export const SIGN_IN_INTERRUPTED_MESSAGE = "Sign-in didn't finish because the app was restarted. Try again.";

export const IDP_UNREACHABLE_MESSAGE = "Couldn't reach the sign-in service. Check the connection and try again.";

/**
 * Token-endpoint error codes (RFC 6749 §5.2) that mean this refresh token will never work again.
 * Anything else (server_error, temporarily_unavailable, a network error) keeps the session.
 */
const SESSION_ENDING_CODES = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_request",
  "invalid_scope",
  "unsupported_grant_type",
]);

/**
 * The OAuth error code of an expo-auth-session TokenError / AuthError (a lower_snake `code`, e.g.
 * `invalid_grant`, `access_denied`, `state_mismatch`), or null. Expo's own errors use upper-case
 * `ERR_…` codes and are not OAuth answers.
 */
export function oauthErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z][a-z_]*$/.test(code) ? code : null;
}

/** True when the IdP answered that the refresh token is no longer valid: the session is over. */
export function isSessionEndingRefreshError(err: unknown): boolean {
  const code = oauthErrorCode(err);
  return code != null && SESSION_ENDING_CODES.has(code);
}

/** True for a request that got no answer at all (fetch's TypeError on RN, browsers, and node). */
export function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  return /network request failed|failed to fetch|load failed|networkerror|network error/i.test(err.message);
}

/** True when Android has no browser that can show the sign-in page (expo-web-browser). */
function isNoBrowser(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /NO_MATCHING_ACTIVITY|NO_PREFERRED_PACKAGE/i.test(code)) return true;
  return err instanceof Error && /no matching browser activity|no preferred package/i.test(err.message);
}

/** A user-facing message for a failed sign-in attempt. Never includes tokens or the authorization code. */
export function signInErrorMessage(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ERR_WEB_BROWSER_BLOCKED") {
    return "The sign-in window was blocked. Allow pop-ups for this site and try again.";
  }
  if (isNoBrowser(err)) {
    return "No web browser is available for the sign-in. Install or enable one (e.g. Chrome) and try again.";
  }
  if (isNetworkFailure(err)) return IDP_UNREACHABLE_MESSAGE;
  // An OAuth answer: the code alone. expo-auth-session's message for it is a paragraph of RFC text.
  const oauthCode = oauthErrorCode(err);
  if (oauthCode) return `Sign-in failed (${oauthCode}). Try again.`;
  const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
  return `Sign-in failed${detail}. Try again.`;
}
