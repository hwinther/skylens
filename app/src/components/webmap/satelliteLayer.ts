/**
 * Pure policy for the Map's satellites layer, shared by the native (react-native-maps) and web
 * (Leaflet) maps so both draw the same thing from the same data:
 *  - which satellites get a marker (exactly the List's Overhead set, at their sub-satellite points),
 *  - when the separate tracked-satellite marker steps aside (no satellite is drawn twice),
 *  - which ONE satellite gets a coverage footprint,
 *  - the short label text and the zoom from which web labels show.
 */

import { footprint, overheadSatellites, type Footprint, type SatelliteView } from "@/ar";

/** One satellite marker on the map. */
export interface MapSatellite {
  noradId: number;
  name: string;
  /** Short display label (see satelliteShortName). */
  label: string;
  /** Sub-satellite point, degrees. */
  lat: number;
  lon: number;
}

/** Leaflet zoom from which satellite names show next to the glyphs (below it: glyph only). */
export const SAT_LABEL_MIN_ZOOM = 4;

/** Longest label before it is cut with an ellipsis. */
export const SAT_LABEL_MAX_CHARS = 14;

/**
 * Short map label for a catalogue name: drops a parenthesised alias ("ISS (ZARYA)" → "ISS",
 * "NAVSTAR 81 (USA 319)" → "NAVSTAR 81") and cuts long names. Falls back to the full trimmed name when
 * stripping would leave nothing.
 */
export function satelliteShortName(name: string): string {
  const full = name.trim();
  const stripped = full.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
  const base = stripped || full;
  return base.length > SAT_LABEL_MAX_CHARS ? `${base.slice(0, SAT_LABEL_MAX_CHARS - 1)}…` : base;
}

/**
 * Markers for the Map's satellites layer: the Overhead set (same order as the List), each at its
 * sub-satellite point. Empty when the layer is off.
 */
export function mapSatellites(visible: readonly SatelliteView[], layerOn: boolean): MapSatellite[] {
  if (!layerOn) return [];
  return overheadSatellites(visible).map((v) => ({
    noradId: v.noradId,
    name: v.name,
    label: satelliteShortName(v.name),
    lat: v.subLat,
    lon: v.subLon,
  }));
}

/**
 * Whether the map should still draw the separate tracked-satellite marker (the ground-track
 * sub-point). It steps aside while the satellites layer already draws that satellite, so it is never
 * drawn twice; the track line itself always stays.
 */
export function showTrackedMarker(trackedNoradId: number | null, markers: readonly MapSatellite[]): boolean {
  if (trackedNoradId == null) return false;
  return !markers.some((m) => m.noradId === trackedNoradId);
}

/**
 * The one satellite that gets a coverage footprint: the one whose detail card is open, else the one
 * whose ground track is shown. Only an overhead satellite (with a live 1 Hz view and a known height)
 * qualifies; anything else draws no footprint.
 */
export function footprintSatellite(
  selectedNoradId: number | null,
  trackedNoradId: number | null,
  byNoradId: ReadonlyMap<number, SatelliteView>,
): SatelliteView | null {
  for (const id of [selectedNoradId, trackedNoradId]) {
    if (id == null) continue;
    const v = byNoradId.get(id);
    if (v && v.altKm != null && v.altKm > 0) return v;
  }
  return null;
}

/** Footprint (0° elevation) of that satellite, or null. */
export function satelliteFootprint(view: SatelliteView | null): Footprint | null {
  if (!view || view.altKm == null) return null;
  return footprint(view.subLat, view.subLon, view.altKm);
}
