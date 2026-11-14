/**
 * The cockpit view's place card and hover hint (pure TS, jest-tested): what a tap in the 3D scene picked
 * (traffic wins over an airport / port label under the same pointer), which already-fetched place a
 * picked label stands for, and the card's wording (kind, codes, distance and bearing from the followed
 * object). Everything comes from the label fetches the screen already holds (OverlayPlace): no calls.
 */

import { compass8 } from "@/components/webmap/relative";
import { bearingDeg, distanceKm, type OverlayLayerKind, type OverlayPlace } from "./overlay";
import { formatKm } from "./route";
import type { TrafficKind, TrafficPick } from "./traffic";

/** A tapped airport / port / ferry-quay label: its OverlayItem.key, nothing more (slim across the webview). */
export interface PlacePick {
  kind: "place";
  id: string;
}

/** What a tap in the scene picked. */
export type SimPick = TrafficPick | PlacePick;

/** The id stamped on traffic primitives. */
export interface TrafficPrimitiveId {
  simTraffic: true;
  kind: TrafficKind;
  id: string;
}

/** The id stamped on airport / port label primitives (point and label). */
export interface PlacePrimitiveId {
  simPlace: true;
  key: string;
}

/**
 * The pick for a set of scene hits (Cesium pick / drillPick results, each `{ id }`), or null. Traffic
 * wins over a place wherever it is in the list: an aircraft passing over an airport label opens the
 * aircraft. Anything else (globe, route line, unstamped primitives) is ignored.
 */
export function resolveSimPick(hits: readonly unknown[]): SimPick | null {
  let place: PlacePick | null = null;
  for (const hit of hits) {
    const id = (hit as { id?: unknown } | null | undefined)?.id as
      | Partial<TrafficPrimitiveId & PlacePrimitiveId>
      | undefined;
    if (!id || typeof id !== "object") continue;
    if (id.simTraffic && (id.kind === "aircraft" || id.kind === "vessel") && id.id) return { kind: id.kind, id: id.id };
    if (!place && id.simPlace && id.key) place = { kind: "place", id: id.key };
  }
  return place;
}

/** True for a place pick (the rest are traffic). */
export function isPlacePick(pick: SimPick): pick is PlacePick {
  return pick.kind === "place";
}

/** The place a picked label stands for, from the places the screen holds per layer; null if gone (refetched). */
export function findPlaceByKey(
  places: Partial<Record<OverlayLayerKind, readonly OverlayPlace[]>>,
  key: string,
): OverlayPlace | null {
  if (!key) return null;
  for (const layer of ["airports", "ports"] as const) {
    const hit = places[layer]?.find((p) => p.key === key);
    if (hit) return hit;
  }
  return null;
}

const KIND_FALLBACK: Record<OverlayPlace["kind"], string> = {
  airport: "Airport",
  port: "Port",
  ferry: "Ferry quay",
};

/** What it is: "Large airport", "Harbour", "Ferry quay" (the kind alone when the data has no type). */
export function placeKindText(p: OverlayPlace): string {
  return p.typeLabel?.trim() || KIND_FALLBACK[p.kind];
}

/** The card's second line: kind, then the codes and the served town where known ("Large airport · ENGM · OSL · Oslo"). */
export function placeDetailText(p: OverlayPlace): string {
  const kind = placeKindText(p);
  const parts = [kind];
  // An unnamed port is titled by its kind (portTitle): say so instead of repeating it.
  if (p.kind !== "airport" && p.name === kind) parts.push("no name in the data");
  if (p.code) parts.push(p.code);
  if (p.iata && p.iata !== p.code) parts.push(p.iata);
  if (p.municipality && p.municipality !== p.name) parts.push(p.municipality);
  return parts.join(" · ");
}

/** Distance and bearing from the followed object: "42 km NE · 045°", or null while it has no position. */
export function placeRangeText(p: OverlayPlace, from: { lat: number; lon: number } | null | undefined): string | null {
  if (!from || !Number.isFinite(from.lat) || !Number.isFinite(from.lon)) return null;
  const km = distanceKm(from.lat, from.lon, p.lat, p.lon);
  const brg = bearingDeg(from.lat, from.lon, p.lat, p.lon);
  const deg = Math.round(brg) % 360;
  return `${formatKm(km)} ${compass8(brg)} · ${String(deg).padStart(3, "0")}°`;
}

/** The hover hint (web): the full name and what it is ("Oslo Airport, Gardermoen · Large airport"). */
export function placeHint(p: OverlayPlace): string {
  const name = p.name || p.code;
  return name ? `${name} · ${placeKindText(p)}` : placeKindText(p);
}
