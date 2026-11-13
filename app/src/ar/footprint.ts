/**
 * Satellite coverage footprint: the small circle on the ground from which a satellite is above the
 * horizon (or above a given elevation). Pure spherical-Earth geometry, no propagation, so it is cheap
 * enough to recompute for one satellite at the 1 Hz satellite tick.
 *
 * For a satellite at height h over a sphere of radius R, the footprint's Earth-central half-angle for a
 * minimum elevation ε is
 *
 *   λ = arccos(R·cos ε / (R + h)) − ε        (ε = 0 → λ = arccos(R / (R + h)))
 *
 * and its ground radius is R·λ. The ring is traced with the great-circle destination formula around the
 * sub-satellite point, then made drawable on a flat (Web Mercator) map: longitudes are unwrapped into a
 * continuous ring, a ring that encloses a pole is closed over that pole, and the result is clipped into
 * the [-180, 180] band (copies shifted by ±360° pick up the part across the antimeridian). Fill polygons
 * and the outline are returned separately so a renderer can stroke the real circle without also
 * stroking the artificial seam / pole-cap edges of the clipped fill.
 */

/** Mean Earth radius (km) — the same sphere the rest of the map math uses. */
export const FOOTPRINT_EARTH_RADIUS_KM = 6371;

/** Web Mercator's latitude limit (deg): both map libraries clamp there, so the geometry does too. */
export const MAP_MAX_LAT = 85.0511;

/** Default number of vertices on the footprint ring (one every 3.75° of bearing). */
export const FOOTPRINT_SEGMENTS = 96;

/** A [lat, lon] pair in degrees — the tuple shape both Leaflet and the native map adapter take. */
export type LatLon = [number, number];

export interface Footprint {
  /** Earth-central half-angle of the coverage circle, degrees. */
  centralAngleDeg: number;
  /** Ground (great-circle) radius of the coverage circle, km. */
  radiusKm: number;
  /** Fill polygons (outer rings, open — the renderer closes them), every vertex within [-180, 180]. */
  polygons: LatLon[][];
  /** The circle itself as polylines, split where it crosses the antimeridian. */
  outline: LatLon[][];
}

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/**
 * Earth-central half-angle (deg) of the region that sees a satellite at `altKm` at or above
 * `minElevationDeg`. 0 for a non-positive / non-finite height (or a mask it can never clear).
 */
export function footprintCentralAngleDeg(altKm: number, minElevationDeg = 0): number {
  if (!Number.isFinite(altKm) || altKm <= 0) return 0;
  const eps = toRad(Math.max(0, Math.min(90, minElevationDeg)));
  const ratio = (FOOTPRINT_EARTH_RADIUS_KM * Math.cos(eps)) / (FOOTPRINT_EARTH_RADIUS_KM + altKm);
  const lambda = Math.acos(Math.min(1, Math.max(-1, ratio))) - eps;
  return lambda > 0 ? toDeg(lambda) : 0;
}

/** Ground radius (km) of the coverage circle: R·λ. */
export function footprintRadiusKm(altKm: number, minElevationDeg = 0): number {
  return FOOTPRINT_EARTH_RADIUS_KM * toRad(footprintCentralAngleDeg(altKm, minElevationDeg));
}

/**
 * The point reached from (lat, lon) along the initial bearing `bearingDeg` after an angular distance
 * `angleDeg` on the sphere. Longitude is NOT normalised (callers unwrap/normalise as they need).
 */
export function destinationPoint(lat: number, lon: number, bearingDeg: number, angleDeg: number): LatLon {
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);
  const θ = toRad(bearingDeg);
  const δ = toRad(angleDeg);
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * sinφ2);
  return [toDeg(φ2), toDeg(λ2)];
}

/** Great-circle central angle (deg) between two points — for tests and callers that check coverage. */
export function centralAngleBetweenDeg(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a[0]);
  const φ2 = toRad(b[0]);
  const Δφ = φ2 - φ1;
  const Δλ = toRad(b[1] - a[1]);
  const h = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return toDeg(2 * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** Shift `lon` by whole turns so it lies within 180° of `ref`. */
function unwrapNear(lon: number, ref: number): number {
  let l = lon;
  while (l - ref > 180) l -= 360;
  while (l - ref < -180) l += 360;
  return l;
}

/** Normalise a longitude to [-180, 180). */
function normLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

const clampLat = (lat: number) => Math.max(-MAP_MAX_LAT, Math.min(MAP_MAX_LAT, lat));

/** Linear interpolation of latitude where segment a→b crosses longitude `x` (a and b straddle x). */
function latAt(a: LatLon, b: LatLon, x: number): number {
  const t = (x - a[1]) / (b[1] - a[1]);
  return a[0] + t * (b[0] - a[0]);
}

/**
 * Sutherland–Hodgman clip of a closed ring (lat/lon treated as planar — fine for a densely sampled
 * ring) against the half-plane `inside`. `edge` is the bounding longitude.
 */
function clipRingHalf(ring: LatLon[], edge: number, keepBelow: boolean): LatLon[] {
  const inside = (p: LatLon) => (keepBelow ? p[1] <= edge : p[1] >= edge);
  const out: LatLon[] = [];
  for (let i = 0; i < ring.length; i++) {
    const cur = ring[i];
    const prev = ring[(i + ring.length - 1) % ring.length];
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push([latAt(prev, cur, edge), edge]);
      out.push(cur);
    } else if (prevIn) {
      out.push([latAt(prev, cur, edge), edge]);
    }
  }
  return out;
}

/** Clip a closed ring to the [-180, 180] longitude band. */
function clipRingToBand(ring: LatLon[]): LatLon[] {
  return clipRingHalf(clipRingHalf(ring, 180, true), -180, false);
}

/**
 * Clip a polyline to the [-180, 180] longitude band, returning the inside runs (each ≥ 2 points), with
 * exact crossing points where it leaves / re-enters the band. For a `closed` line (last vertex = first)
 * a run that ends on the closing vertex is joined to the run that starts on the first one, so a circle
 * cut by the seam comes back as one piece per side.
 */
function clipLineToBand(line: LatLon[], closed = false): LatLon[][] {
  const runs: LatLon[][] = [];
  let cur: LatLon[] = [];
  const within = (p: LatLon) => p[1] >= -180 && p[1] <= 180;
  for (let i = 0; i < line.length; i++) {
    const p = line[i];
    const prev = i > 0 ? line[i - 1] : null;
    if (prev) {
      // Entering / leaving through either band edge (a segment is never wider than the band).
      for (const edge of [-180, 180]) {
        const crosses = (prev[1] - edge) * (p[1] - edge) < 0;
        if (!crosses) continue;
        const x: LatLon = [latAt(prev, p, edge), edge];
        if (within(prev)) {
          cur.push(x);
          if (cur.length >= 2) runs.push(cur);
          cur = [];
        } else {
          cur = [x];
        }
      }
    }
    if (within(p)) cur.push(p);
  }
  if (cur.length >= 2) runs.push(cur);
  if (closed && runs.length > 1) {
    const head = runs[0];
    const tail = runs[runs.length - 1];
    const start = line[0];
    const end = line[line.length - 1];
    if (head[0] === start && tail[tail.length - 1] === end) {
      runs[0] = [...tail, ...head.slice(1)];
      runs.pop();
    }
  }
  return runs;
}

/** True when a clipped ring still has area (≥ 3 vertices spread over some longitude and latitude). */
function hasArea(ring: LatLon[]): boolean {
  if (ring.length < 3) return false;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [la, lo] of ring) {
    minLon = Math.min(minLon, lo);
    maxLon = Math.max(maxLon, lo);
    minLat = Math.min(minLat, la);
    maxLat = Math.max(maxLat, la);
  }
  return maxLon - minLon > 1e-9 && maxLat - minLat > 1e-9;
}

/**
 * Coverage footprint of a satellite whose sub-satellite point is (subLat, subLon) at height `altKm`,
 * for a minimum elevation `minElevationDeg` (default 0 = the geometric horizon). Null when the height
 * is unusable (no footprint).
 */
export function footprint(
  subLat: number,
  subLon: number,
  altKm: number,
  opts?: { minElevationDeg?: number; segments?: number },
): Footprint | null {
  if (!Number.isFinite(subLat) || !Number.isFinite(subLon)) return null;
  const centralAngleDeg = footprintCentralAngleDeg(altKm, opts?.minElevationDeg ?? 0);
  if (centralAngleDeg <= 0) return null;
  const n = Math.max(8, Math.round(opts?.segments ?? FOOTPRINT_SEGMENTS));
  // Exactly at a pole every bearing is degenerate; nudge off it (sub-metre, invisible on the map).
  const lat0 = Math.max(-89.9999, Math.min(89.9999, subLat));
  const lon0 = normLon(subLon);

  // Trace the ring with continuous (unwrapped) longitudes; vertex n repeats bearing 0 to close it.
  const ring: LatLon[] = [];
  for (let i = 0; i <= n; i++) {
    const [la, lo] = destinationPoint(lat0, lon0, (360 * i) / n, centralAngleDeg);
    const ref = i === 0 ? lon0 : ring[i - 1][1];
    ring.push([la, unwrapNear(lo, ref)]);
  }
  const first = ring[0];
  const last = ring[n];
  // A ring around a pole does not close in unwrapped longitude: it ends a whole turn from its start.
  const enclosesPole = Math.abs(last[1] - first[1]) > 180;

  let fill: LatLon[];
  if (enclosesPole) {
    // Close the polygon over the enclosed pole (the hemisphere the sub-point is in).
    const poleLat = lat0 >= 0 ? 90 : -90;
    fill = [...ring, [poleLat, last[1]], [poleLat, first[1]]];
  } else {
    fill = ring.slice(0, n); // open ring (last vertex duplicates the first)
  }

  // Copies shifted by whole turns, each clipped into [-180, 180]: together they tile the footprint.
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of fill) {
    minLon = Math.min(minLon, p[1]);
    maxLon = Math.max(maxLon, p[1]);
  }
  const shifts: number[] = [];
  for (let k = Math.floor((-180 - maxLon) / 360); k <= Math.ceil((180 - minLon) / 360); k++) {
    shifts.push(k * 360);
  }

  const polygons: LatLon[][] = [];
  const outline: LatLon[][] = [];
  for (const s of shifts) {
    if (maxLon + s < -180 || minLon + s > 180) continue;
    const shiftedFill = fill.map(([la, lo]): LatLon => [la, lo + s]);
    const clipped = clipRingToBand(shiftedFill);
    if (hasArea(clipped)) polygons.push(clipped.map(([la, lo]): LatLon => [clampLat(la), lo]));
    const shiftedRing = ring.map(([la, lo]): LatLon => [la, lo + s]);
    for (const run of clipLineToBand(shiftedRing, !enclosesPole)) {
      outline.push(run.map(([la, lo]): LatLon => [clampLat(la), lo]));
    }
  }

  return {
    centralAngleDeg,
    radiusKm: FOOTPRINT_EARTH_RADIUS_KM * toRad(centralAngleDeg),
    polygons,
    outline,
  };
}
