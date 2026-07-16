/**
 * The satellite fetch's failure backoff must start SHORT (cold-start failures — a 401 racing
 * token hydration, or a 503/slow first CelesTrak fetch on the backend — clear within seconds)
 * and escalate to a cap so a genuinely-down backend isn't hammered. A flat 5-minute backoff
 * here is what left the AR view empty after sign-in while the list screen fetched fine.
 */

import { retryDelayMs } from "@/components/useSatellites";

describe("retryDelayMs", () => {
  it("starts at 10s and doubles per consecutive failure", () => {
    expect(retryDelayMs(0)).toBe(10_000);
    expect(retryDelayMs(1)).toBe(20_000);
    expect(retryDelayMs(2)).toBe(40_000);
    expect(retryDelayMs(3)).toBe(80_000);
    expect(retryDelayMs(4)).toBe(160_000);
  });

  it("caps at 5 minutes", () => {
    expect(retryDelayMs(5)).toBe(300_000);
    expect(retryDelayMs(6)).toBe(300_000);
    expect(retryDelayMs(50)).toBe(300_000);
  });

  it("recovers a cold start in under a minute of cumulative retries", () => {
    // First three retries land at +10s, +30s, +70s — well inside the window where the backend's
    // first CelesTrak fetch (a few seconds) and the user's sign-in have both completed.
    const cumulative = retryDelayMs(0) + retryDelayMs(1) + retryDelayMs(2);
    expect(cumulative).toBeLessThanOrEqual(70_000);
  });
});
