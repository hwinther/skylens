/**
 * Client-side failure reporting. The app posts summaries of its OWN failed requests to
 * /api/client-log so they land in the backend's logs (→ OTLP → Loki → Grafana) — the only place a
 * client-only failure is ever visible: an auth error, or an edge gateway (CrowdSec) 403'ing
 * app-shaped traffic before it reaches Kestrel produces no backend trace at all.
 *
 * Buffered in memory and flushed opportunistically: a *total* edge block can't phone home (the
 * flush POST is blocked too — that's what the VPS canary probe is for), but the buffer recovers the
 * session's failure history once connectivity returns (the next successful request, or a hub
 * reconnect). Flushing uses fetch directly — never the ApiClient — so a failed flush can't report
 * itself and loop.
 */

import Constants from "expo-constants";

export interface ClientFailure {
  /** HTTP method of the failed request. */
  method: string;
  /** Request path, e.g. "/api/aircraft". */
  endpoint: string;
  /** HTTP status, or null for a network-level failure (no response — a dropped edge block looks like this). */
  status: number | null;
  /** Whether the response carried the backend's X-Skylens-Api marker (absent ⇒ blocked before Kestrel). */
  edgeMarkerPresent: boolean;
  /** Short detail (truncated error / body), optional. */
  detail?: string;
}

const USER_AGENT = `Skylens/${Constants.expoConfig?.version ?? "0.0.0"}`;
const MAX_BUFFER = 50;

const buffer: ClientFailure[] = [];
let flushing = false;

/** Record a failed request. Keeps only the most recent MAX_BUFFER entries (drops oldest). */
export function reportClientFailure(failure: ClientFailure): void {
  buffer.push(failure);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
}

/**
 * Flush buffered failures to /api/client-log. No-op when empty or already flushing; re-buffers on
 * failure so a still-blocked edge doesn't lose history. `fetchImpl` is injectable for tests.
 */
export async function flushClientLog(baseUrl: string, fetchImpl?: typeof fetch): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const entries = buffer.splice(0, buffer.length);
  const doFetch = fetchImpl ?? fetch.bind(globalThis);
  try {
    const res = await doFetch(`${baseUrl.replace(/\/+$/, "")}/api/client-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: entries.map((e) => ({ ...e, userAgent: USER_AGENT })) }),
    });
    if (!res.ok) buffer.unshift(...entries);
  } catch {
    buffer.unshift(...entries);
  } finally {
    flushing = false;
  }
}

/** Test hook: reset the module-level buffer. */
export function resetClientLog(): void {
  buffer.length = 0;
  flushing = false;
}
