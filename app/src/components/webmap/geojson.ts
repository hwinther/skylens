/**
 * Pure GeoJSON → map-coordinate conversion for the fishing-mode overlays. The backend passes upstream
 * FiskInfo geometry through verbatim, so it reaches the app as a loose object; these helpers narrow it
 * to the handful of geometry types we render (Polygon / MultiPolygon / LineString / Point) and emit the
 * two coordinate shapes the two map engines want:
 *   - Leaflet (web): [lat, lng] tuples — react-leaflet's <Polygon>/<Polyline>/<Marker> positions.
 *   - react-native-maps (native): { latitude, longitude } objects — via toLatLng / toLatLngs.
 *
 * GeoJSON positions are [lon, lat] (longitude first!), so every conversion swaps the pair. Everything
 * here is defensive: a malformed or empty geometry yields [] (or null for a Point) so the map simply
 * renders nothing — which is exactly what an unconfigured backend (empty arrays) should look like too.
 */

/** Leaflet position: [lat, lng]. */
export type LatLngTuple = [number, number];

/** react-native-maps position. */
export interface LatLng {
  latitude: number;
  longitude: number;
}

/** One polygon in Leaflet order: an outer ring plus zero or more hole rings. */
export interface PolygonRings {
  outer: LatLngTuple[];
  holes: LatLngTuple[][];
}

/** The loose GeoJSON geometry the backend forwards (coordinates typed `unknown` — we validate at runtime). */
export interface GeoGeometry {
  type?: string | null;
  coordinates?: unknown;
}

/** A finite number guard (rejects NaN/Infinity that would corrupt the map viewport). */
function isFinite2(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * One GeoJSON position ([lon, lat, ...]) → a Leaflet [lat, lng] tuple, or null when the position is not
 * a `[number, number]`-prefixed array (any trailing altitude/measure is ignored).
 */
export function positionToLatLng(pos: unknown): LatLngTuple | null {
  if (!Array.isArray(pos) || pos.length < 2) return null;
  const lon = pos[0];
  const lat = pos[1];
  if (!isFinite2(lon) || !isFinite2(lat)) return null;
  return [lat, lon];
}

/** A ring/line (array of positions) → Leaflet tuples, silently dropping any malformed positions. */
export function ringToLatLngs(ring: unknown): LatLngTuple[] {
  if (!Array.isArray(ring)) return [];
  const out: LatLngTuple[] = [];
  for (const pos of ring) {
    const p = positionToLatLng(pos);
    if (p) out.push(p);
  }
  return out;
}

/** One GeoJSON Polygon coordinate array (rings[0] = outer, rings[1..] = holes) → PolygonRings, or null. */
function ringsToPolygon(rings: unknown): PolygonRings | null {
  if (!Array.isArray(rings) || rings.length === 0) return null;
  const outer = ringToLatLngs(rings[0]);
  if (outer.length === 0) return null;
  const holes: LatLngTuple[][] = [];
  for (let i = 1; i < rings.length; i++) {
    const hole = ringToLatLngs(rings[i]);
    if (hole.length > 0) holes.push(hole);
  }
  return { outer, holes };
}

/**
 * Polygon / MultiPolygon geometry → a list of polygons (Leaflet order). A Polygon yields one entry, a
 * MultiPolygon yields one per member; any other/malformed/empty geometry yields []. Empty rings are
 * dropped, so the result only contains renderable polygons.
 */
export function polygonRings(geom: GeoGeometry | null | undefined): PolygonRings[] {
  if (!geom || !Array.isArray(geom.coordinates)) return [];
  if (geom.type === "Polygon") {
    const poly = ringsToPolygon(geom.coordinates);
    return poly ? [poly] : [];
  }
  if (geom.type === "MultiPolygon") {
    const out: PolygonRings[] = [];
    for (const rings of geom.coordinates) {
      const poly = ringsToPolygon(rings);
      if (poly) out.push(poly);
    }
    return out;
  }
  return [];
}

/** LineString geometry → Leaflet tuples; any other/malformed geometry → []. */
export function lineLatLngs(geom: GeoGeometry | null | undefined): LatLngTuple[] {
  if (!geom || geom.type !== "LineString") return [];
  return ringToLatLngs(geom.coordinates);
}

/** Point geometry → a single Leaflet tuple; any other/malformed geometry → null. */
export function pointLatLng(geom: GeoGeometry | null | undefined): LatLngTuple | null {
  if (!geom || geom.type !== "Point") return null;
  return positionToLatLng(geom.coordinates);
}

/** Leaflet [lat, lng] tuple → a react-native-maps { latitude, longitude }. */
export function toLatLng(t: LatLngTuple): LatLng {
  return { latitude: t[0], longitude: t[1] };
}

/** Map a run of Leaflet tuples to react-native-maps objects. */
export function toLatLngs(ts: LatLngTuple[]): LatLng[] {
  return ts.map(toLatLng);
}
