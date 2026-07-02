/**
 * Runtime API base URL resolution. Reads EXPO_PUBLIC_API_BASE_URL (baked at build
 * time by Expo's public-env convention) and falls back to the production host.
 * Demo mode never touches the network, so this only matters once a live backend is
 * configured.
 */

const DEFAULT_BASE_URL = "https://skylens.wsh.no";

export function getApiBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_BASE_URL;
}
