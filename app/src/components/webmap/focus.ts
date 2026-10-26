/**
 * Resolves a map focus (see mapFocusStore) against the live traffic lists. Pure and platform-neutral,
 * shared by the native and Leaflet maps. A target that has dropped out of the feed resolves with
 * `position: null` but keeps its label, so the Map can say "signal lost" instead of silently
 * forgetting what the user asked for.
 */

import type { AircraftDto, VesselDto } from "@/api/types";
import type { MapFocus } from "@/state/mapFocusStore";

export interface FocusTarget {
  kind: MapFocus["kind"];
  /** Stable identity (hex / mmsi), used to re-centre once per new target. */
  id: string;
  /** Callsign / ship name, falling back to the id. */
  label: string;
  /** Current position, or null when the target is not in the live lists right now. */
  position: { lat: number; lon: number } | null;
}

/**
 * Initial zoom when centring, as a region span in degrees (native) — aircraft move ~15 km/min so
 * they get a wider frame than ships.
 */
export const FOCUS_SPAN_DEG: Record<MapFocus["kind"], number> = { aircraft: 0.6, vessel: 0.12 };

/** Leaflet equivalent of FOCUS_SPAN_DEG: the minimum zoom level to centre at. */
export const FOCUS_ZOOM: Record<MapFocus["kind"], number> = { aircraft: 10, vessel: 13 };

function position(lat: number | null | undefined, lon: number | null | undefined) {
  return lat != null && lon != null ? { lat, lon } : null;
}

export function resolveFocus(
  focus: MapFocus | null,
  aircraft: readonly AircraftDto[],
  vessels: readonly VesselDto[],
): FocusTarget | null {
  if (!focus) return null;
  if (focus.kind === "aircraft") {
    const a = aircraft.find((x) => x.hex === focus.hex);
    return {
      kind: "aircraft",
      id: focus.hex,
      label: a?.flight?.trim() || focus.hex.toUpperCase(),
      position: position(a?.lat, a?.lon),
    };
  }
  const v = vessels.find((x) => x.mmsi === focus.mmsi);
  return {
    kind: "vessel",
    id: focus.mmsi,
    label: v?.name?.trim() || focus.mmsi,
    position: position(v?.lat, v?.lon),
  };
}
