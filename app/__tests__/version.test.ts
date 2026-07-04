/**
 * getVersionLine formats the App version cell from the baked EXPO_PUBLIC_* env (web build) and
 * falls back to the app.json version + a "dev" marker when nothing is baked (native dev build).
 * expo-constants is mocked so the fallback branch is deterministic.
 */

import { getVersionLine } from "@/lib/version";

// jest.mock is hoisted above the import above, so expo-constants is stubbed before version.ts loads.
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { version: "9.9.9" } },
}));

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567"; // 40 chars

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("getVersionLine", () => {
  const origVersion = process.env.EXPO_PUBLIC_APP_VERSION;
  const origSha = process.env.EXPO_PUBLIC_GIT_SHA;

  afterEach(() => {
    setEnv("EXPO_PUBLIC_APP_VERSION", origVersion);
    setEnv("EXPO_PUBLIC_GIT_SHA", origSha);
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
});
