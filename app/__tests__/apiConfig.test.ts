/**
 * In production on web getApiBaseUrl returns the page's own origin, so a single bundle serves the
 * API host-agnostically from skylens.wsh.no AND the skylens-N.preview.wsh.no preview hosts. On
 * native (no window/origin) it falls back to the hardcoded production host. The explicit env
 * override still wins. `__DEV__` is toggled off to reach the production branch.
 */

import { getApiBaseUrl } from "@/api/config";

const g = globalThis as Record<string, unknown>;

describe("getApiBaseUrl (production)", () => {
  const origEnv = process.env.EXPO_PUBLIC_API_BASE_URL;
  const origDev = g.__DEV__;
  const origLoc = g.location;

  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    g.__DEV__ = false;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
    else process.env.EXPO_PUBLIC_API_BASE_URL = origEnv;
    g.__DEV__ = origDev;
    if (origLoc === undefined) delete g.location;
    else g.location = origLoc;
  });

  it("returns the page origin on the production host", () => {
    g.location = { origin: "https://skylens.wsh.no", hostname: "skylens.wsh.no" };
    expect(getApiBaseUrl()).toBe("https://skylens.wsh.no");
  });

  it("returns a preview host origin unchanged (same bundle, different host)", () => {
    g.location = { origin: "https://skylens-7.preview.wsh.no", hostname: "skylens-7.preview.wsh.no" };
    expect(getApiBaseUrl()).toBe("https://skylens-7.preview.wsh.no");
  });

  it("still honours an explicit EXPO_PUBLIC_API_BASE_URL override", () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = "http://localhost:5000";
    g.location = { origin: "https://skylens.wsh.no", hostname: "skylens.wsh.no" };
    expect(getApiBaseUrl()).toBe("http://localhost:5000");
  });

  it("falls back to the native production host when there is no origin", () => {
    delete g.location;
    expect(getApiBaseUrl()).toBe("https://skylens.wsh.no");
  });
});
