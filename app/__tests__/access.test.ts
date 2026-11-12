/**
 * The root layout asks an anonymous GET /api/me whether the backend wants a sign-in: DevAuth (local
 * dev, e2e, previews) answers 200, real auth 401. apiAccess turns that plus the session status into
 * the gate every API caller checks.
 */

import { accessAllowsApi, apiAccess, probeAuthRequired, type ApiAccess } from "@/auth/access";
import type { AuthStatus } from "@/state/authStore";

function fetchReturning(status: number): jest.Mock {
  return jest.fn(async () => new Response("{}", { status }));
}

const asFetch = (m: jest.Mock) => m as unknown as typeof fetch;

describe("probeAuthRequired", () => {
  it("is false when the backend answers anonymously (DevAuth)", async () => {
    await expect(probeAuthRequired("http://x", asFetch(fetchReturning(200)))).resolves.toBe(false);
  });

  it("is true when the backend wants a sign-in", async () => {
    await expect(probeAuthRequired("http://x", asFetch(fetchReturning(401)))).resolves.toBe(true);
  });

  it("is null for any other answer, so the caller asks again", async () => {
    await expect(probeAuthRequired("http://x", asFetch(fetchReturning(503)))).resolves.toBeNull();
    await expect(probeAuthRequired("http://x", asFetch(fetchReturning(403)))).resolves.toBeNull();
  });

  it("is null on a network error", async () => {
    const failing = jest.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(probeAuthRequired("http://x", asFetch(failing))).resolves.toBeNull();
  });

  it("calls /api/me with no Authorization header", async () => {
    const fetchImpl = fetchReturning(200);
    await probeAuthRequired("https://skylens.example/", asFetch(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe("https://skylens.example/api/me");
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
  });
});

describe("apiAccess", () => {
  const cases: [AuthStatus, boolean | null, ApiAccess][] = [
    ["authenticated", true, "signed-in"],
    ["authenticated", false, "signed-in"],
    ["authenticated", null, "signed-in"],
    ["unauthenticated", false, "open"],
    ["authenticating", false, "open"],
    ["unknown", false, "open"],
    ["unauthenticated", true, "sign-in-required"],
    ["authenticating", true, "sign-in-required"],
    ["unknown", true, "unknown"],
    ["unauthenticated", null, "unknown"],
    ["unknown", null, "unknown"],
  ];

  it.each(cases)("status %s, authRequired %s → %s", (status, required, expected) => {
    expect(apiAccess(status, required)).toBe(expected);
  });

  it("allows API calls only when open or signed in", () => {
    expect(accessAllowsApi("open")).toBe(true);
    expect(accessAllowsApi("signed-in")).toBe(true);
    expect(accessAllowsApi("sign-in-required")).toBe(false);
    expect(accessAllowsApi("unknown")).toBe(false);
  });
});
