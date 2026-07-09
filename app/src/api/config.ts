/**
 * Runtime API base URL resolution. Reads EXPO_PUBLIC_API_BASE_URL (baked at build
 * time by Expo's public-env convention) and falls back to the production host.
 * Demo mode never touches the network, so this only matters once a live backend is
 * configured.
 */

import Constants from "expo-constants";
import { NativeModules } from "react-native";

const DEFAULT_BASE_URL = "https://skylens.wsh.no";
const DEV_BACKEND_PORT = 5000;

/**
 * The host serving this JS session — i.e. the dev machine — so a physical device reaches the backend
 * on the same host with no hardcoded LAN IP. Sources, in order:
 *  - web: the page's own hostname.
 *  - native dev build: the Metro bundle URL (where our JS came from), e.g.
 *    "http://10.20.1.163:8081/index.bundle?platform=android"; expo-constants as a fallback.
 * Returns null in production / when unavailable.
 */
function devServerHost(): string | null {
  const webHost = (globalThis as { location?: { hostname?: string } }).location?.hostname;
  if (webHost) return webHost;

  const scriptURL = (NativeModules as { SourceCode?: { scriptURL?: string } })?.SourceCode?.scriptURL;
  const hostPort =
    (scriptURL ? scriptURL.split("://")[1]?.split("/")[0] : undefined) ??
    Constants.expoConfig?.hostUri ??
    (Constants as { expoGoConfig?: { debuggerHost?: string } }).expoGoConfig?.debuggerHost;
  if (!hostPort) return null;

  return hostPort.split("/")[0].split(":")[0] || null;
}

/**
 * Backend base URL. Precedence:
 *   1. EXPO_PUBLIC_API_BASE_URL (explicit override — set it for a non-default port or remote backend).
 *   2. In dev, http://<metro-host>:5000 — works for web (localhost) AND a physical device (the PC's
 *      LAN IP, same host Metro serves from), with no per-machine config.
 *   3. Production web: the page's own origin, so the one bundle serves the API from wherever it is
 *      hosted — skylens.wsh.no AND the skylens-N.preview.wsh.no preview hosts — with no rebuild.
 *   4. Production native: the hardcoded production host (no window/origin on native).
 */
export function getApiBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  if (__DEV__) {
    const host = devServerHost();
    if (host) return `http://${host}:${DEV_BACKEND_PORT}`;
  }

  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (origin) return origin;

  return DEFAULT_BASE_URL;
}

/** A fixed observer position. `alt` (metres above mean sea level) is optional — omitted → 0. */
export interface HomeLocation {
  lat: number;
  lon: number;
  alt?: number;
}

/**
 * Optional fixed observer location from EXPO_PUBLIC_HOME_LAT/LON (plus optional
 * EXPO_PUBLIC_HOME_ALT, metres above mean sea level). Live mode uses this as the hub subscription
 * centre (and the projection origin) until GPS provides a fix — on web / the E2E there is no GPS,
 * so this is what makes live mode deterministic. Altitude feeds the AR elevation angle
 * (geodeticToEnu); without it the observer sits at sea level. Home coordinates are never committed
 * (repo convention); absent lat/lon → null and live mode simply waits for a GPS fix.
 */
export function getHomeLocation(): HomeLocation | null {
  const lat = Number(process.env.EXPO_PUBLIC_HOME_LAT);
  const lon = Number(process.env.EXPO_PUBLIC_HOME_LON);
  if (!(Number.isFinite(lat) && Number.isFinite(lon))) return null;
  const alt = Number(process.env.EXPO_PUBLIC_HOME_ALT);
  return Number.isFinite(alt) ? { lat, lon, alt } : { lat, lon };
}
