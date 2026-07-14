/**
 * Pure-TypeScript projection of Jupiter's four Galilean moons onto the sky, for the planet detail
 * sheet's classic "binocular view" finder strip.
 *
 * `JupiterMoons(date)` gives each moon's position relative to Jupiter's centre (jovicentric), in AU,
 * in the EQJ frame (Earth's equator at J2000). `GeoVector(Body.Jupiter, date, true)` gives Jupiter's
 * geocentric position in the same frame. A moon's geocentric position is `jupiterGeo + moonJovicentric`,
 * so its offset FROM Jupiter as seen from Earth is `moonGeo − jupiterGeo`, which reduces exactly to the
 * jovicentric vector (jupiterGeo cancels) — we use that directly.
 *
 * Projection convention (standard finder-chart / astronomical): we build an orthonormal basis
 * perpendicular to the Earth→Jupiter line of sight, with +x pointing celestial EAST and +y celestial
 * NORTH, and express each moon's transverse offset as a small angle in arcseconds. This is NOT flipped
 * for a mirror-reversed eyepiece — the renderer decides which way east points on screen and labels it.
 *
 * astronomy-engine is pure JS (no WASM, no data files), so — like planets.ts / radioSky.ts — this stays
 * a pure deterministic function of `date` and imports nothing from react-native / expo / react (see the
 * src/ar/ eslint guard) so jest can exercise it on any platform.
 */

import { Body, GeoVector, JupiterMoons } from "astronomy-engine";

/** Astronomical unit in km (IAU 2012). Converts the moons' AU distances to km. */
export const AU_KM = 149597870.7;
/** Radians → arcseconds: (180/π)·3600. */
export const RAD2ARCSEC = (180 / Math.PI) * 3600;
/** Jupiter's equatorial radius in km (IAU) — for the disc's angular size. */
export const JUPITER_EQUATORIAL_RADIUS_KM = 71492;

/** One Galilean moon reduced to a plane-of-sky offset from Jupiter at a single instant. */
export interface JovianMoonView {
  /** Stable key AND ordering (inner → outer). */
  key: "io" | "europa" | "ganymede" | "callisto";
  /** Display name, e.g. "Io". */
  name: string;
  /** Transverse offset toward celestial EAST, arcseconds (+east, −west). */
  xArcsec: number;
  /** Transverse offset toward celestial NORTH, arcseconds (+north, −south). */
  yArcsec: number;
  /** 3-D separation from Jupiter's centre, km (|jovicentric|). */
  distanceKmFromJupiter: number;
}

/** Jupiter + its four moons projected onto the plane of sky at one instant. */
export interface JupiterMoonsView {
  /** The four moons in fixed inner→outer order (io, europa, ganymede, callisto). */
  moons: JovianMoonView[];
  /** Jupiter's apparent angular radius, arcseconds (equatorial radius / distance). */
  jupiterAngularRadiusArcsec: number;
  /** max(|xArcsec|) across the four moons — the natural half-width to scale the strip to. */
  maxAbsXArcsec: number;
}

const MOONS: { key: JovianMoonView["key"]; name: string }[] = [
  { key: "io", name: "Io" },
  { key: "europa", name: "Europa" },
  { key: "ganymede", name: "Ganymede" },
  { key: "callisto", name: "Callisto" },
];

type Vec3 = [number, number, number];

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/**
 * Compute the plane-of-sky configuration of Jupiter's four Galilean moons at `date`.
 *
 * Basis: `losHat` = unit Earth→Jupiter direction (from `GeoVector`); `east` = normalize(z × losHat)
 * with z the EQJ celestial north pole, `north` = losHat × east — an orthonormal, right-handed
 * {east, north, los} triad (well-conditioned since Jupiter hugs the ecliptic, never near the pole where
 * z × los would degenerate). Each moon's jovicentric offset `rel` projects to
 * `xArcsec = (rel·east / |jupiterGeo|)·RAD2ARCSEC` (east) and `yArcsec = (rel·north / |jupiterGeo|)·RAD2ARCSEC`
 * (north); the component along the line of sight is dropped, so the projected separation can only shrink
 * relative to the true 3-D separation.
 */
export function computeJupiterMoons(date: Date): JupiterMoonsView {
  const info = JupiterMoons(date);
  const jup = GeoVector(Body.Jupiter, date, true);
  const jupiterGeo: Vec3 = [jup.x, jup.y, jup.z];
  const jupiterDistanceAu = norm(jupiterGeo);
  const losHat = scale(jupiterGeo, 1 / jupiterDistanceAu);

  const zAxis: Vec3 = [0, 0, 1]; // EQJ celestial north pole
  const eastRaw = cross(zAxis, losHat);
  const east = scale(eastRaw, 1 / norm(eastRaw));
  const north = cross(losHat, east);

  const state = { io: info.io, europa: info.europa, ganymede: info.ganymede, callisto: info.callisto };
  const moons: JovianMoonView[] = MOONS.map(({ key, name }) => {
    const sv = state[key];
    // moonGeo − jupiterGeo reduces exactly to the jovicentric vector (jupiterGeo cancels).
    const rel: Vec3 = [sv.x, sv.y, sv.z];
    return {
      key,
      name,
      xArcsec: (dot(rel, east) / jupiterDistanceAu) * RAD2ARCSEC,
      yArcsec: (dot(rel, north) / jupiterDistanceAu) * RAD2ARCSEC,
      distanceKmFromJupiter: norm(rel) * AU_KM,
    };
  });

  const jupiterDistanceKm = jupiterDistanceAu * AU_KM;
  return {
    moons,
    jupiterAngularRadiusArcsec: (JUPITER_EQUATORIAL_RADIUS_KM / jupiterDistanceKm) * RAD2ARCSEC,
    maxAbsXArcsec: Math.max(...moons.map((m) => Math.abs(m.xArcsec))),
  };
}
