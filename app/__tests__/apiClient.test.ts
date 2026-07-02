import { ApiClient, ApiError } from "@/api/client";
import type { AircraftSnapshot } from "@/api/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ApiClient", () => {
  it("injects the bearer token and Accept header", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return jsonResponse({ ts: 1, aircraft: [] } satisfies AircraftSnapshot);
    }) as unknown as typeof fetch;

    const client = new ApiClient({
      baseUrl: "https://skylens.wsh.no/",
      getToken: () => "tok123",
      fetchImpl,
    });
    await client.aircraft();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://skylens.wsh.no/api/aircraft");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer tok123");
    expect(calls[0].headers.get("Accept")).toBe("application/json");
  });

  it("omits Authorization when no token", async () => {
    let seen: Headers | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return jsonResponse({ ts: 1, aircraft: [] });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://x", getToken: () => null, fetchImpl });
    await client.aircraft();
    expect(seen!.get("Authorization")).toBeNull();
  });

  it("builds the radius query string", async () => {
    let url = "";
    const fetchImpl = (async (u: string) => {
      url = String(u);
      return jsonResponse({ ts: 1, aircraft: [] });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://x", getToken: () => null, fetchImpl });
    await client.aircraft({ lat: 59.9, lon: 10.7, radiusKm: 60 });
    expect(url).toBe("http://x/api/aircraft?lat=59.9&lon=10.7&radiusKm=60");
  });

  it("hits the explicit /route endpoint only when asked", async () => {
    let url = "";
    const fetchImpl = (async (u: string) => {
      url = String(u);
      return jsonResponse({ callsign: "SAS1782", origin: "ENGM", destination: "ESSA" });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://x", getToken: () => null, fetchImpl });
    await client.aircraftRoute("4ca7b3");
    expect(url).toBe("http://x/api/aircraft/4ca7b3/route");
  });

  it("throws ApiError with status on non-2xx", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: "unauthorized" }, 401)) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://x", getToken: () => null, fetchImpl });
    await expect(client.me()).rejects.toBeInstanceOf(ApiError);
    await expect(client.me()).rejects.toMatchObject({ status: 401 });
  });
});
