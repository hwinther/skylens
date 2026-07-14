import { ApiClient, ApiError } from "@/api/client";
import { resetClientLog } from "@/api/clientLog";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ApiClient", () => {
  // Failures are buffered at module scope for /api/client-log; reset so cases don't leak into each other.
  beforeEach(() => resetClientLog());

  it("injects the bearer token and Accept header", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return jsonResponse([]);
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
      return jsonResponse([]);
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://x", getToken: () => null, fetchImpl });
    await client.aircraft();
    expect(seen!.get("Authorization")).toBeNull();
  });

  it("builds the radius query string", async () => {
    let url = "";
    const fetchImpl = (async (u: string) => {
      url = String(u);
      return jsonResponse([]);
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

  it("flags a failure with no X-Skylens-Api marker as edge-blocked", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://x", getToken: () => null, fetchImpl });
    await expect(client.me()).rejects.toMatchObject({ status: 403, edgeBlocked: true });
  });

  it("treats a failure carrying the marker as a real API outcome, not edge-blocked", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "X-Skylens-Api": "1.2.3" },
      })) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://x", getToken: () => null, fetchImpl });
    await expect(client.me()).rejects.toMatchObject({ status: 403, edgeBlocked: false });
  });

  it("hits the fishing-zones endpoint", async () => {
    let url = "";
    const fetchImpl = (async (u: string) => {
      url = String(u);
      return jsonResponse({ fetchedAtUtc: "2026-01-01T00:00:00Z", zones: [], note: null });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://x", getToken: () => null, fetchImpl });
    const res = await client.fishingZones();
    expect(url).toBe("http://x/api/fishing/zones");
    expect(res.zones).toEqual([]);
  });

  it("hits the lost-gear endpoint", async () => {
    let url = "";
    const fetchImpl = (async (u: string) => {
      url = String(u);
      return jsonResponse({ fetchedAtUtc: "2026-01-01T00:00:00Z", gear: [], note: "fiskinfo-unconfigured" });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://x", getToken: () => null, fetchImpl });
    const res = await client.lostGear();
    expect(url).toBe("http://x/api/fishing/lostgear");
    expect(res.note).toBe("fiskinfo-unconfigured");
  });

  it("builds the airports query string", async () => {
    let url = "";
    const fetchImpl = (async (u: string) => {
      url = String(u);
      return jsonResponse({ fetchedAt: "2026-01-01T00:00:00Z", airports: [] });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://x", getToken: () => null, fetchImpl });
    const res = await client.airports(58.2, 8.08, 150);
    expect(url).toBe("http://x/api/airports?lat=58.2&lon=8.08&radiusKm=150");
    expect(res.airports).toEqual([]);
  });
});
