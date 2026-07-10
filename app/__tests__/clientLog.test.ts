import { flushClientLog, reportClientFailure, resetClientLog } from "@/api/clientLog";

describe("clientLog", () => {
  beforeEach(() => resetClientLog());

  it("posts buffered failures to /api/client-log (with a Skylens UA) and clears the buffer", async () => {
    const calls: { url: string; body: { entries: { endpoint: string; edgeMarkerPresent: boolean; userAgent: string }[] } }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    reportClientFailure({ method: "GET", endpoint: "/api/aircraft", status: 403, edgeMarkerPresent: false });
    await flushClientLog("https://skylens.wsh.no/", fetchImpl);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://skylens.wsh.no/api/client-log");
    expect(calls[0].body.entries).toHaveLength(1);
    expect(calls[0].body.entries[0].endpoint).toBe("/api/aircraft");
    expect(calls[0].body.entries[0].edgeMarkerPresent).toBe(false);
    expect(calls[0].body.entries[0].userAgent).toMatch(/^Skylens\//);

    // Buffer is drained → a second flush is a no-op (no extra POST).
    await flushClientLog("https://skylens.wsh.no/", fetchImpl);
    expect(calls).toHaveLength(1);
  });

  it("no-ops when the buffer is empty", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await flushClientLog("http://x", fetchImpl);
    expect(called).toBe(false);
  });

  it("re-buffers on a failed flush so nothing is lost", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      return new Response(null, { status: attempts === 1 ? 502 : 204 });
    }) as unknown as typeof fetch;

    reportClientFailure({ method: "GET", endpoint: "/api/me", status: 401, edgeMarkerPresent: true });
    await flushClientLog("http://x", fetchImpl); // 502 → re-buffered
    await flushClientLog("http://x", fetchImpl); // retry → 204 (only reached because it was re-buffered)
    expect(attempts).toBe(2);
  });
});
