/**
 * Runtime API base URL resolution. Reads EXPO_PUBLIC_API_BASE_URL (baked at build
 * time by Expo's public-env convention) and falls back to the production host.
 * Demo mode never touches the network, so this only matters once a live backend is
 * configured.
 */

import Constants from "expo-constants";

const DEFAULT_BASE_URL = "https://skylens.wsh.no";
const DEV_BACKEND_PORT = 5000;

/**
 * The host Metro is served from (e.g. "10.20.1.163:8081" on a physical device, "localhost:8081"
 * on web / emulator). We reuse it to reach the backend running on the same PC, so a device doesn't
 * need the machine's LAN IP hardcoded. null when unavailable.
 */
function devServerHost(): string | null {
  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants as { expoGoConfig?: { debuggerHost?: string } }).expoGoConfig?.debuggerHost ??
    null;
  if (!hostUri) return null;
  const host = hostUri.split("/")[0].split(":")[0];
  return host || null;
}

/**
 * Backend base URL. Precedence:
 *   1. EXPO_PUBLIC_API_BASE_URL (explicit override — set it for a non-default port or remote backend).
 *   2. In dev, http://<metro-host>:5000 — works for web (localhost) AND a physical device (the PC's
 *      LAN IP, same host Metro serves from), with no per-machine config.
 *   3. Production host.
 */
export function getApiBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  if (__DEV__) {
    const host = devServerHost();
    if (host) return `http://${host}:${DEV_BACKEND_PORT}`;
  }

  return DEFAULT_BASE_URL;
}

/** A fixed observer position (lat/lon). */
export interface HomeLocation {
  lat: number;
  lon: number;
}

/**
 * Optional fixed observer location from EXPO_PUBLIC_HOME_LAT/LON. Live mode uses this as the
 * hub subscription centre (and the projection origin) until GPS provides a fix — on web / the
 * E2E there is no GPS, so this is what makes live mode deterministic. Home coordinates are never
 * committed (repo convention); absent env → null and live mode simply waits for a GPS fix.
 */
export function getHomeLocation(): HomeLocation | null {
  const lat = Number(process.env.EXPO_PUBLIC_HOME_LAT);
  const lon = Number(process.env.EXPO_PUBLIC_HOME_LON);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}
