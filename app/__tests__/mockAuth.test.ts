import { mintMockToken, MOCK_USER } from "@/auth/mockAuth";

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const g = globalThis as { Buffer?: { from: (s: string, enc: string) => { toString: (enc: string) => string } } };
  const json =
    typeof atob === "function" ? atob(b64) : g.Buffer!.from(b64, "base64").toString("utf-8");
  return JSON.parse(json);
}

describe("mintMockToken", () => {
  it("produces a three-part JWT-shaped token", () => {
    const t = mintMockToken();
    expect(t.accessToken.split(".")).toHaveLength(3);
    expect(t.mock).toBe(true);
  });

  it("encodes the mock user claims and the API audience", () => {
    const now = 1_700_000_000_000;
    const t = mintMockToken(now);
    const payload = decodeJwtPayload(t.accessToken);
    expect(payload.sub).toBe(MOCK_USER.sub);
    expect(payload.aud).toBe("skylens-api");
    expect(payload.groups).toEqual(MOCK_USER.groups);
    expect(payload.exp).toBe(Math.floor(now / 1000) + 3600);
  });

  it("sets expiresAt ~1h in the future", () => {
    const now = 1_700_000_000_000;
    const t = mintMockToken(now);
    expect(t.expiresAt).toBe(now + 3600 * 1000);
  });
});
