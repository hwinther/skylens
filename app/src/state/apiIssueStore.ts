/**
 * The latest REST failure worth telling the user about, shown by ApiIssueBanner. Fed by ApiClient on
 * the same failures it reports to /api/client-log (auth, edge blocks, server errors, no response);
 * routine 4xx a caller expects (a cached-route 404) never land here.
 *
 * Before this, a failing layer just drew nothing: airports, ports and satellites all got 401 after
 * the access token expired while the hub still said "connected", and the only trace was the console.
 *
 * A success on the same endpoint clears the issue (the layer recovered). Dismissing hides that kind
 * of issue for DISMISS_MS so a layer that keeps failing doesn't nag on every refetch. Not persisted.
 */

import { create } from "zustand";

export type ApiIssueKind = "auth" | "forbidden" | "blocked" | "server" | "network";

export interface ApiIssue {
  kind: ApiIssueKind;
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  /** Request path without the query string, e.g. "/api/ports". */
  endpoint: string;
  /** Failures seen since the issue first appeared (shown as "×N"). */
  count: number;
}

/** How long a dismissed kind stays quiet. */
export const DISMISS_MS = 5 * 60_000;

/** Classify a failed request; null for failures the user doesn't need to see. */
export function classifyFailure(status: number | null, reachedBackend: boolean): ApiIssueKind | null {
  if (status == null) return "network";
  if (!reachedBackend) return "blocked";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status >= 500) return "server";
  return null;
}

/** "/api/ports?lat=1&lon=2" → "/api/ports". */
export function endpointOf(path: string): string {
  const q = path.indexOf("?");
  return q < 0 ? path : path.slice(0, q);
}

/** One-line, user-facing text for an issue. */
export function describeApiIssue(issue: ApiIssue): string {
  const what = issue.endpoint.replace(/^\/api\//, "");
  const times = issue.count > 1 ? ` ×${issue.count}` : "";
  switch (issue.kind) {
    case "auth":
      return `Session expired — couldn't load ${what} (401)${times}. Sign in again.`;
    case "forbidden":
      return `Access denied loading ${what} (403)${times}.`;
    case "blocked":
      return `Request for ${what} was blocked before reaching the server (${issue.status})${times}.`;
    case "server":
      return `Server error loading ${what} (${issue.status})${times}.`;
    case "network":
      return `Couldn't reach the server for ${what}${times}. Check the connection.`;
  }
}

interface ApiIssueState {
  issue: ApiIssue | null;
  /** Per-kind "quiet until" timestamps set by dismiss. */
  mutedUntil: Partial<Record<ApiIssueKind, number>>;
  report: (path: string, status: number | null, reachedBackend: boolean, now?: number) => void;
  succeeded: (path: string) => void;
  dismiss: (now?: number) => void;
}

export const useApiIssueStore = create<ApiIssueState>((set, get) => ({
  issue: null,
  mutedUntil: {},
  report: (path, status, reachedBackend, now = Date.now()) => {
    const kind = classifyFailure(status, reachedBackend);
    if (!kind) return;
    if ((get().mutedUntil[kind] ?? 0) > now) return;
    const endpoint = endpointOf(path);
    const prev = get().issue;
    const count = prev && prev.kind === kind && prev.endpoint === endpoint ? prev.count + 1 : 1;
    set({ issue: { kind, status, endpoint, count } });
  },
  succeeded: (path) => {
    const issue = get().issue;
    if (issue && issue.endpoint === endpointOf(path)) set({ issue: null });
  },
  dismiss: (now = Date.now()) => {
    const issue = get().issue;
    if (!issue) return;
    set((s) => ({ issue: null, mutedUntil: { ...s.mutedUntil, [issue.kind]: now + DISMISS_MS } }));
  },
}));
