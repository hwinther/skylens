/**
 * Fetches one overlay layer (airports or ports around a point) and turns it into 3D labels. Shared by
 * the web screen (called from the Cesium overlay loop) and the Android screen (handed to the globe's
 * webview as a native action, so the API call and its auth stay on the native side).
 */

import type { ApiClient } from "@/api/client";
import {
  AIRPORT_FETCH_RADIUS_KM,
  airportOverlayItems,
  PORT_FETCH_RADIUS_KM,
  portOverlayItems,
  type OverlayItem,
  type OverlayLayerKind,
} from "./overlay";

export async function fetchOverlayItems(
  client: Pick<ApiClient, "airports" | "ports">,
  layer: OverlayLayerKind,
  lat: number,
  lon: number,
): Promise<OverlayItem[]> {
  if (layer === "airports") {
    const res = await client.airports(lat, lon, AIRPORT_FETCH_RADIUS_KM);
    return airportOverlayItems(res.airports ?? []);
  }
  const res = await client.ports(lat, lon, PORT_FETCH_RADIUS_KM);
  return portOverlayItems(res.ports ?? []);
}
