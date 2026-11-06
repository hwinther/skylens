/**
 * App version line for display, in order of preference:
 *
 *  1. Baked EXPO_PUBLIC_APP_VERSION / EXPO_PUBLIC_GIT_SHA → "<version> · <sha7>". The hosted web
 *     Docker build and the Android release workflow (android-build.yml) both set them.
 *  2. The installed native version (expo-application's nativeApplicationVersion, i.e. the Android
 *     versionName the Play Store shows). Release builds fall back to it when nothing is baked, so
 *     the About screen can never disagree with the store listing.
 *  3. The app.json version (Constants.expoConfig?.version).
 *
 * The "dev" marker appears only in __DEV__ bundles. Release builds used to show "0.1.0 · dev"
 * because the CI Gradle step had no version env, so the embedded config kept app.json's 0.1.0.
 *
 * Mirrors the proven pattern in the sibling clutterstock repo (frontend/app/lib/version.ts),
 * adapted from Vite's import.meta.env to Expo's process.env.EXPO_PUBLIC_* + expo-constants.
 */

import * as Application from "expo-application";
import Constants from "expo-constants";

export function getVersionLine(): { line: string; sha: string } {
  const version = process.env.EXPO_PUBLIC_APP_VERSION ?? "";
  const sha = process.env.EXPO_PUBLIC_GIT_SHA ?? "";
  const parts: string[] = [];
  if (version) parts.push(version);
  if (sha) parts.push(sha.slice(0, 7));
  if (parts.length > 0) {
    return { line: parts.join(" · "), sha };
  }

  // Nothing baked: use the installed native version (null on web), then app.json.
  const fallbackVersion =
    Application.nativeApplicationVersion || Constants.expoConfig?.version || "";
  if (!__DEV__) return { line: fallbackVersion || "unknown", sha: "" };
  return { line: fallbackVersion ? `${fallbackVersion} · dev` : "dev", sha: "" };
}
