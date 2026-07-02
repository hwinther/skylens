/**
 * OIDC configuration for the Authelia identity provider at auth.wsh.no.
 *
 * The backend validates RFC 9068 JWTs with audience `skylens-api`, so we request
 * that audience implicitly via the `skylens` public client (Authelia issues the
 * access token signed with the shared RSA key). Scopes include offline_access so we
 * get a refresh token, and groups so the backend can do group-based authorization.
 */

export const OIDC_ISSUER = "https://auth.wsh.no";

export const OIDC_CLIENT_ID = "skylens";

/** The API audience the backend's JwtBearer expects. */
export const OIDC_AUDIENCE = "skylens-api";

export const OIDC_SCOPES = [
  "openid",
  "profile",
  "email",
  "groups",
  "offline_access",
];

/**
 * The custom URL scheme used for the OAuth redirect. Must match app.json `scheme`
 * and the Authelia client `redirect_uris`. makeRedirectUri({ scheme }) builds
 * `skylens://oauth` (or the applicationId form on a dev/prod build).
 */
export const OIDC_SCHEME = "skylens";

/** Redirect path appended to the scheme. */
export const OIDC_REDIRECT_PATH = "oauth";
