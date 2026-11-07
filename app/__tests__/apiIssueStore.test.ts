/**
 * User-visible REST failures: which failures surface, the banner text, recovery on a later success,
 * and dismiss muting a kind for a while so a layer that keeps failing doesn't nag.
 */

import {
  classifyFailure,
  describeApiIssue,
  DISMISS_MS,
  endpointOf,
  useApiIssueStore,
} from "@/state/apiIssueStore";

beforeEach(() => useApiIssueStore.setState({ issue: null, mutedUntil: {} }));

test("only incident-worthy failures surface", () => {
  expect(classifyFailure(401, true)).toBe("auth");
  expect(classifyFailure(403, true)).toBe("forbidden");
  expect(classifyFailure(403, false)).toBe("blocked"); // no backend marker: an edge gateway
  expect(classifyFailure(503, true)).toBe("server");
  expect(classifyFailure(null, false)).toBe("network");
  expect(classifyFailure(404, true)).toBeNull(); // e.g. a cached-route miss the caller expects
});

test("the endpoint drops the query string", () => {
  expect(endpointOf("/api/ports?lat=59.86&lon=10.53&radiusKm=150")).toBe("/api/ports");
  expect(endpointOf("/api/satellites")).toBe("/api/satellites");
});

test("a 401 reads as an expired session and repeats are counted", () => {
  const { report } = useApiIssueStore.getState();
  report("/api/ports?lat=1&lon=2", 401, true);
  report("/api/ports?lat=1&lon=2", 401, true);
  const issue = useApiIssueStore.getState().issue!;
  expect(issue).toMatchObject({ kind: "auth", endpoint: "/api/ports", count: 2 });
  expect(describeApiIssue(issue)).toBe("Session expired — couldn't load ports (401) ×2. Sign in again.");
});

test("a later success on the same endpoint clears it; another endpoint doesn't", () => {
  const s = useApiIssueStore.getState();
  s.report("/api/airports?lat=1", 500, true);
  s.succeeded("/api/ports?lat=1");
  expect(useApiIssueStore.getState().issue).not.toBeNull();
  s.succeeded("/api/airports?lat=2");
  expect(useApiIssueStore.getState().issue).toBeNull();
});

test("dismiss mutes that kind for a while, other kinds still show", () => {
  const s = useApiIssueStore.getState();
  s.report("/api/ports", 401, true, 1000);
  s.dismiss(1000);
  s.report("/api/ports", 401, true, 2000);
  expect(useApiIssueStore.getState().issue).toBeNull();
  s.report("/api/airports", 502, true, 2000);
  expect(useApiIssueStore.getState().issue?.kind).toBe("server");
  useApiIssueStore.setState({ issue: null });
  s.report("/api/ports", 401, true, 1000 + DISMISS_MS + 1);
  expect(useApiIssueStore.getState().issue?.kind).toBe("auth");
});
