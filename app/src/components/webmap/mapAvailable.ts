/**
 * Whether the geographic Map can draw on this platform. Web uses Leaflet/OSM and iOS uses Apple Maps,
 * so both always can. Android uses the Google provider, which renders blank without an API key;
 * app.config.js records whether the build had one as `extra.hasMapsKey` (`android.config` itself is
 * stripped from the public config, so the key can't be read at runtime). A separate module so tests
 * can mock it.
 */

import Constants from "expo-constants";
import { Platform } from "react-native";

export function isMapAvailable(): boolean {
  if (Platform.OS !== "android") return true;
  return Constants.expoConfig?.extra?.hasMapsKey === true;
}
