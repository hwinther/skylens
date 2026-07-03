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
