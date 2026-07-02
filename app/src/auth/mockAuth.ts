/**
 * Mock-auth mode. Custom-scheme OAuth needs a dev build (the AuthSession proxy is
 * gone in SDK 54+), so until that build exists — and for Expo Go / emulator dev —
 * we let a settings toggle skip OIDC entirely and mint a fake token.
 *
 * The fake access token is a syntactically valid unsigned JWT so any client-side
 * decoding still works; the backend obviously rejects it, so mock mode is paired
 * with the backend's `Auth__Disabled` dev escape hatch or the mock feed. This file
 * is pure logic (no react-native) so it is unit-testable.
 */

import type { StoredTokens } from "./tokenStore";
import type { MeResponse } from "@/api/types";

export const MOCK_USER: MeResponse = {
  sub: "mock-user",
  preferredUsername: "demo",
  name: "Demo User",
  email: "demo@example.com",
  groups: ["skylens-users"],
};

function base64Url(input: string): string {
  // btoa is available in the Hermes/RN runtime and under jest-expo/node.
  const b64 = typeof btoa === "function" ? btoa(input) : bufferBase64(input);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bufferBase64(input: string): string {
  // Fallback for environments without btoa.
  const g = globalThis as { Buffer?: { from: (s: string, enc: string) => { toString: (enc: string) => string } } };
  if (g.Buffer) return g.Buffer.from(input, "utf-8").toString("base64");
  throw new Error("No base64 encoder available");
}

/** Build a fake (unsigned) JWT-shaped access token for mock mode. */
export function mintMockToken(now = Date.now()): StoredTokens {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const exp = Math.floor(now / 1000) + 3600;
  const payload = base64Url(
    JSON.stringify({
      sub: MOCK_USER.sub,
      preferred_username: MOCK_USER.preferredUsername,
      name: MOCK_USER.name,
      email: MOCK_USER.email,
      groups: MOCK_USER.groups,
      aud: "skylens-api",
      iss: "skylens-mock",
      exp,
    }),
  );
  const accessToken = `${header}.${payload}.`;
  return {
    accessToken,
    refreshToken: null,
    idToken: accessToken,
    expiresAt: now + 3600 * 1000,
    mock: true,
  };
}
