/**
 * App version line for display. The hosted web Docker build bakes EXPO_PUBLIC_APP_VERSION
 * (semver from GitVersion) and EXPO_PUBLIC_GIT_SHA (the full 40-char commit sha) into the
 * bundle; we render "<version> · <sha7>". Native dev builds have neither baked, so we fall
 * back to the app.json version (Constants.expoConfig?.version) with a "dev" marker.
 *
 * Mirrors the proven pattern in the sibling clutterstock repo (frontend/app/lib/version.ts),
 * adapted from Vite's import.meta.env to Expo's process.env.EXPO_PUBLIC_* + expo-constants.
 */

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

  // Env not baked (native dev build): fall back to the app.json version + a dev marker.
  const fallbackVersion = Constants.expoConfig?.version ?? "";
  return { line: fallbackVersion ? `${fallbackVersion} · dev` : "dev", sha: "" };
}
