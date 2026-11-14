/**
 * Pure-TS policy for the cockpit view's map aids: how far the minimap zooms out per object, when the
 * airport overlay refetches, and from how far each airport class gets a label in the 3D view. Kept free
 * of Cesium / Leaflet / React so jest runs it anywhere.
 */

import type { AirportDto, PortDto, PortKind } from "@/api/types";
import { airportShortLabel, airportTypeLabel } from "@/components/webmap/airportStyle";
import { portKindLabel, portTitle } from "@/components/webmap/portStyle";
import { color } from "@/theme";
import { FEET_TO_M, type SimKind } from "./simPose";

/**
 * Which filter group an overlay point belongs to (the cockpit filter, ./layers.ts). Ferry quays are
 * split from the other ports: /api/ports tags each place with its OSM/WPI kind, and along the coast
 * the many ferry quays were hard to tell from the harbours.
 */
export type OverlayGroup = "airports" | "ports" | "ferries";

/** Ferry quays' points and label text in the 3D view (the other ports keep PORT_COLOR + white). */
export const FERRY_COLOR = color.ferry;

/**
 * One labelled point in the 3D scene (airport or port). Plain JSON, so it also crosses the native →
 * DOM-component bridge on Android (the native screen fetches, the webview draws).
 */
export interface OverlayItem {
  lat: number;
  lon: number;
  altM: number;
  /** Empty → point only. */
  label: string;
  rangeM: number;
  pixelSize: number;
  /** Filter group (shown/hidden as one). */
  group: OverlayGroup;
  /** CSS colour for the point and label text; the layer's colour + white text when absent. */
  color?: string;
  /**
   * The place's key (placeKey), stamped on its primitives so a tap can name it; the screen resolves it
   * to the full place it already holds (OverlayPlace.key). Absent → not pickable.
   */
  key?: string;
}

/** Data credit shown with a place: OurAirports for airports, ODbL / NGA for ports by source. */
export const AIRPORT_CREDIT = "Airports: OurAirports (public domain)";
export const PORT_CREDIT_OSM = "© OpenStreetMap contributors (ODbL)";
export const PORT_CREDIT_WPI = "World Port Index (NGA)";

/** A place's pick key: "airport:<ident>" or "port:<id>" (ferry quays are ports in /api/ports). */
export function airportKey(a: Pick<AirportDto, "ident">): string {
  return `airport:${a.ident}`;
}
export function portKey(p: Pick<PortDto, "id">): string {
  return `port:${p.id}`;
}

/**
 * A named reference place behind the labels, kept by the screen (not the globe) for the HUD's
 * "nearest airport / port" line and to find the destination airport of a known route. Slim and
 * plain JSON, from the same fetch as the labels: no extra calls.
 */
export interface OverlayPlace {
  kind: "airport" | "port" | "ferry";
  /** Airport ident (ICAO for most), or "" for ports. */
  code: string;
  name: string;
  lat: number;
  lon: number;
  altM: number;
  /** Matches the label's OverlayItem.key (absent on places not drawn as labels, e.g. a looked-up destination). */
  key?: string;
  /** What it is, in words: "Large airport", "Harbour", "Ferry quay". */
  typeLabel?: string;
  /** IATA code (airports), when the dataset has one. */
  iata?: string;
  /** Municipality / served city (airports), when the dataset has one. */
  municipality?: string;
  /** The data credit to show with it (ODbL for OpenStreetMap ports). */
  credit?: string;
}

/** The two labelled-point layers of the 3D view. */
export type OverlayLayerKind = "airports" | "ports";

/**
 * Minimap zoom (Leaflet / slippy-map levels). Low and slow → close in; cruise altitude → the region;
 * orbit → most of a hemisphere. Altitude in metres.
 */
export function minimapZoom(kind: SimKind, altM: number): number {
  if (kind === "satellite") return 2;
  if (kind === "vessel") return 12;
  if (altM < 600) return 12;
  if (altM < 3000) return 10;
  return 8;
}

/** Airports are refetched once the object has moved this far from the last fetch centre. */
export const AIRPORT_REFETCH_KM = 30;

/** Radius of each airport fetch around the object. */
export const AIRPORT_FETCH_RADIUS_KM = 150;

/**
 * Furthest distance (metres) at which an airport of this OurAirports class is labelled in the 3D view,
 * or null to never show it: the big ones are landmarks from cruise altitude, small fields only matter up
 * close (a helicopter or a low aircraft). Heliports and seaplane bases are left out — too many, too small.
 */
export function airportLabelRangeM(type: string): number | null {
  switch (type) {
    case "large_airport":
      return 150_000;
    case "medium_airport":
      return 80_000;
    case "small_airport":
      return 20_000;
    default:
      return null;
  }
}

/** Ports are refetched once the object has moved this far from the last fetch centre. */
export const PORT_REFETCH_KM = 10;

/**
 * Radius of each port fetch. Smaller than the airports': the Norwegian coast has a quay or marina every
 * few km and the API returns at most 500 (nearest first), so a wide radius would only thin out the
 * ones close by.
 */
export const PORT_FETCH_RADIUS_KM = 40;

/**
 * Furthest distance (metres) at which a port of this kind is labelled in the 3D view. Commercial ports
 * are landmarks; marinas and ferry quays only matter close in (a vessel, a helicopter, a low approach).
 */
export function portLabelRangeM(kind: PortKind): number {
  switch (kind) {
    case "port":
      return 40_000;
    case "harbour":
      return 15_000;
    case "ferry":
      return 10_000;
    case "marina":
      return 6_000;
  }
}

/** The 3D airport overlay is for the view from the air or the water; from orbit it's just clutter. */
export function showsAirportOverlay(kind: SimKind): boolean {
  return kind !== "satellite";
}

/** Same rule for the ports overlay. */
export function showsPortOverlay(kind: SimKind): boolean {
  return kind !== "satellite";
}

/** Airports from GET /api/airports as 3D labels; classes without a label range are left out. */
export function airportOverlayItems(airports: readonly AirportDto[]): OverlayItem[] {
  const items: OverlayItem[] = [];
  for (const a of airports) {
    const rangeM = airportLabelRangeM(a.type);
    if (rangeM == null) continue;
    items.push({
      lat: a.lat,
      lon: a.lon,
      // Field elevation + a little, so the marker sits on the runway, not under the terrain.
      altM: (a.elevationFt ?? 0) * FEET_TO_M + 20,
      label: airportShortLabel(a),
      rangeM,
      pixelSize: a.type === "large_airport" ? 9 : 6,
      group: "airports",
      key: airportKey(a),
    });
  }
  return items;
}

/** Airports as reference places (the labelled classes only: no heliports or seaplane bases). */
export function airportPlaces(airports: readonly AirportDto[]): OverlayPlace[] {
  const places: OverlayPlace[] = [];
  for (const a of airports) {
    if (airportLabelRangeM(a.type) == null) continue;
    places.push({
      kind: "airport",
      code: a.ident,
      name: a.name,
      lat: a.lat,
      lon: a.lon,
      altM: (a.elevationFt ?? 0) * FEET_TO_M,
      key: airportKey(a),
      typeLabel: airportTypeLabel(a.type),
      ...(a.iata?.trim() ? { iata: a.iata.trim() } : {}),
      ...(a.municipality?.trim() ? { municipality: a.municipality.trim() } : {}),
      credit: AIRPORT_CREDIT,
    });
  }
  return places;
}

/** Ports as reference places; ferry quays keep their own kind. */
export function portPlaces(ports: readonly PortDto[]): OverlayPlace[] {
  return ports.map((p) => ({
    kind: p.kind === "ferry" ? "ferry" : "port",
    code: "",
    name: portTitle(p),
    lat: p.lat,
    lon: p.lon,
    altM: 0,
    key: portKey(p),
    typeLabel: portKindLabel(p.kind),
    credit: p.id.startsWith("wpi") ? PORT_CREDIT_WPI : PORT_CREDIT_OSM,
  }));
}

/**
 * Ports from GET /api/ports as 3D labels. Ferry quays go to their own filter group and are drawn in
 * FERRY_COLOR (point and label text), so they read apart from the harbours, marinas and ports.
 */
export function portOverlayItems(ports: readonly PortDto[]): OverlayItem[] {
  return ports.map((p) => ({
    lat: p.lat,
    lon: p.lon,
    altM: 8, // quay level
    // Unnamed quays and marinas get a dot only ("Marina" forty times along a fjord is noise); an
    // unnamed commercial port is still a landmark, so it keeps its kind as the label.
    label: p.name?.trim() || (p.kind === "port" ? portTitle(p) : ""),
    rangeM: portLabelRangeM(p.kind),
    pixelSize: p.kind === "port" ? 8 : 5,
    ...(p.kind === "ferry" ? { group: "ferries" as const, color: FERRY_COLOR } : { group: "ports" as const }),
    key: portKey(p),
  }));
}

/** Great-circle distance in km (haversine), for the refetch check and the traffic / nearest-place ranges. */
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from a to b, degrees true [0, 360). */
export function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const p1 = toRad(aLat);
  const p2 = toRad(bLat);
  const dl = toRad(bLon - aLon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (((Math.atan2(y, x) * 180) / Math.PI) % 360 + 360) % 360;
}
