/**
 * Pure-TypeScript math for the AR "surface band" — the horizon-pinned layer ships and AtoN are
 * drawn in.
 *
 * A vessel sits at sea level, so its true elevation from the observer is a tiny, jittery negative
 * angle that would place it right on (or just under) the horizon and make it wobble frame to frame.
 * Instead we ignore the vessel's elevation entirely: we render it ON the visual horizon at its true
 * bearing (project { azimuth, elevation: 0 } through the pose — done in the overlay) and then push
 * it *down* by a distance-scaled offset. Near ships drop into a shallow band below the horizon;
 * distant ships ride essentially on it. That gives a readable sense of range without depending on a
 * degenerate elevation angle.
 *
 * Must import nothing from react-native / expo / react (see the src/ar/ eslint guard). The only
 * dependency is the shared aircraft deadReckon, reused for moving ships.
 */

import { deadReckon } from "./smoothing";

/** Maximum downward offset (px) below the horizon a very-near vessel is drawn at. */
export const BAND_PX = 64;

/**
 * Distance falloff constant (px·km). The band offset is K / distanceKm, clamped to [0, BAND_PX].
 * With K = BAND_PX the knee is exactly 1 km: a ship at 1 km sits a full band below the horizon, one
 * at 2 km sits ~half a band down (32 px), and anything past ~20 km sits within a few px of the
 * horizon (K/20 ≈ 3 px) — "essentially on it". Ships nearer than the 0.5 km floor all clamp to the
 * band so they never race off the bottom of the screen.
 */
export const SURFACE_BAND_K = BAND_PX;

/** Distance floor (km) so a vessel right on top of the observer doesn't blow the offset up. */
export const SURFACE_BAND_MIN_KM = 0.5;

/** Vessels farther than this are dropped before projection — keeps the horizon from turning to soup. */
export const VESSEL_DISTANCE_CAP_KM = 40;

/**
 * Hard cap on rendered vessels per frame (nearest-first). Bounds the extra work the 20 fps overlay
 * loop does — projection + the O(n²) declutter pass — when a busy AIS feed reports hundreds of ships.
 */
export const VESSEL_RENDER_CAP = 40;

/**
 * Downward pixel offset below the horizon for a vessel at `distanceKm`. Monotonically non-increasing
 * in distance, clamped to [0, BAND_PX]: near ships get the full band, far ships ~0.
 */
export function surfaceBandOffset(distanceKm: number): number {
  const d = Math.max(distanceKm, SURFACE_BAND_MIN_KM);
  const dy = SURFACE_BAND_K / d;
  return Math.max(0, Math.min(BAND_PX, dy));
}

export interface VesselMotion {
  lat: number;
  lon: number;
  /** Speed over ground, knots. */
  sog?: number | null;
  /** Course over ground, degrees true (0 = North, clockwise). */
  cog?: number | null;
}

/**
 * Dead-reckon a moving ship forward by `dtSeconds` using its course/speed over ground, mapped onto
 * the shared aircraft deadReckon (sog → gs knots, cog → trk degrees, sea level, no vertical rate).
 *
 * A vessel with no positive speed or no known course is left where it is — we never fabricate a
 * default northward drift. AtoN (fixed aids) must NOT be passed here; they never move.
 */
export function deadReckonVessel(v: VesselMotion, dtSeconds: number): { lat: number; lon: number } {
  const sog = v.sog ?? 0;
  const cog = v.cog;
  if (sog <= 0 || cog == null || !Number.isFinite(cog)) {
    return { lat: v.lat, lon: v.lon };
  }
  const dr = deadReckon({ lat: v.lat, lon: v.lon, alt: 0, gs: sog, trk: cog, vr: 0 }, dtSeconds);
  return { lat: dr.lat, lon: dr.lon };
}
