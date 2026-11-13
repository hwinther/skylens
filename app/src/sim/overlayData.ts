/**
 * Fetches one overlay layer (airports or ports around a point) and turns it into 3D labels. Shared by
 * the web screen (called from the Cesium overlay loop) and the Android screen (handed to the globe's
 * webview as a native action, so the API call and its auth stay on the native side).
 */

import type { ApiClient } from "@/api/client";
import {
  AIRPORT_FETCH_RADIUS_KM,
  airportOverlayItems,
  airportPlaces,
  PORT_FETCH_RADIUS_KM,
  portOverlayItems,
  portPlaces,
  type OverlayItem,
  type OverlayLayerKind,
  type OverlayPlace,
} from "./overlay";

export interface OverlayFetch {
  /** The 3D labels (handed to the globe). */
  items: OverlayItem[];
  /** The same places, slim, for the screen's HUD (nearest airport/port, destination lookup). */
  places: OverlayPlace[];
}

/** One fetch, both views of it: labels for the globe and places for the screen. */
export async function fetchOverlay(
  client: Pick<ApiClient, "airports" | "ports">,
  layer: OverlayLayerKind,
  lat: number,
  lon: number,
): Promise<OverlayFetch> {
  if (layer === "airports") {
    const airports = (await client.airports(lat, lon, AIRPORT_FETCH_RADIUS_KM)).airports ?? [];
    return { items: airportOverlayItems(airports), places: airportPlaces(airports) };
  }
  const ports = (await client.ports(lat, lon, PORT_FETCH_RADIUS_KM)).ports ?? [];
  return { items: portOverlayItems(ports), places: portPlaces(ports) };
}

export async function fetchOverlayItems(
  client: Pick<ApiClient, "airports" | "ports">,
  layer: OverlayLayerKind,
  lat: number,
  lon: number,
): Promise<OverlayItem[]> {
  return (await fetchOverlay(client, layer, lat, lon)).items;
}
