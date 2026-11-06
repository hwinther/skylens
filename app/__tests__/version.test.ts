/**
 * getVersionLine formats the App version cell from the baked EXPO_PUBLIC_* env (web build, CI
 * Android build). With nothing baked it falls back to the installed native version, then app.json,
 * and adds the "dev" marker only in __DEV__. expo-constants and expo-application are mocked so the
 * fallback branches are deterministic.
 */

import { getVersionLine } from "@/lib/version";

// jest.mock is hoisted above the import above, so expo-constants is stubbed before version.ts loads.
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { version: "9.9.9" } },
}));

jest.mock("expo-application", () => ({ __esModule: true, nativeApplicationVersion: null }));
const mockApplication = jest.requireMock<{ nativeApplicationVersion: string | null }>("expo-application");

const g = globalThis as { __DEV__?: boolean };

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567"; // 40 chars

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("getVersionLine", () => {
  const origVersion = process.env.EXPO_PUBLIC_APP_VERSION;
  const origSha = process.env.EXPO_PUBLIC_GIT_SHA;

  const origDev = g.__DEV__;

  afterEach(() => {
    setEnv("EXPO_PUBLIC_APP_VERSION", origVersion);
    setEnv("EXPO_PUBLIC_GIT_SHA", origSha);
    mockApplication.nativeApplicationVersion = null;
    g.__DEV__ = origDev;
  });

  it("renders '<version> · <sha7>' when both env vars are baked", () => {
    setEnv("EXPO_PUBLIC_APP_VERSION", "1.4.2");
    setEnv("EXPO_PUBLIC_GIT_SHA", FULL_SHA);
    const { line, sha } = getVersionLine();
    expect(line).toBe("1.4.2 · 0123456");
    expect(sha).toBe(FULL_SHA);
  });

  it("renders just the version when only the version is baked", () => {
    setEnv("EXPO_PUBLIC_APP_VERSION", "1.4.2");
    setEnv("EXPO_PUBLIC_GIT_SHA", undefined);
    const { line, sha } = getVersionLine();
    expect(line).toBe("1.4.2");
    expect(sha).toBe("");
  });

  it("falls back to the app.json version + dev marker when nothing is baked", () => {
    setEnv("EXPO_PUBLIC_APP_VERSION", undefined);
    setEnv("EXPO_PUBLIC_GIT_SHA", undefined);
    const { line, sha } = getVersionLine();
    expect(line).toBe("9.9.9 · dev");
    expect(sha).toBe("");
  });

  it("prefers the installed native version over app.json in a dev build", () => {
    setEnv("EXPO_PUBLIC_APP_VERSION", undefined);
    setEnv("EXPO_PUBLIC_GIT_SHA", undefined);
    g.__DEV__ = true;
    mockApplication.nativeApplicationVersion = "0.19.0";
    expect(getVersionLine().line).toBe("0.19.0 · dev");
  });

  it("shows the installed version without a dev marker in a release build", () => {
    // The Play-installed 0.19.0 build used to read "0.1.0 · dev" here.
    setEnv("EXPO_PUBLIC_APP_VERSION", undefined);
    setEnv("EXPO_PUBLIC_GIT_SHA", undefined);
    g.__DEV__ = false;
    mockApplication.nativeApplicationVersion = "0.19.0";
    expect(getVersionLine()).toEqual({ line: "0.19.0", sha: "" });
  });
});
