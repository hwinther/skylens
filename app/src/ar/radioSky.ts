/**
 * Pure-TypeScript fixed-radio-source ephemeris for the AR overlay's radio pass.
 *
 * A niche layer for hydrogen-line / general radio observing: four bright, FIXED celestial radio
 * sources (Sgr A*, Cas A, Cyg A, Tau A) reduced to observer-relative azimuth / elevation the projection
 * layer consumes exactly like a planet's. Unlike the planets these are invisible to the eye and never
 * move against the stars, so each is a fixed J2000 RA/Dec — a "user-defined star" in astronomy-engine
 * terms (`DefineStar`). We reuse the SAME `Equator`(of-date)+`Horizon` reduction planets.ts uses, so a
 * radio target lands on the same sky as the Sun/Moon/planets.
 *
 * The 21 cm neutral-hydrogen line (rest frequency 1420.405751 MHz) is the canonical amateur
 * radio-astronomy target; the observed line Doppler-shifts with galactic rotation (LSR), so its sky
 * frequency drifts by direction — see the detail sheet's note.
 *
 * `DefineStar` mutates one of eight global "star" slots (Star1..Star8). We give each source a STABLE
 * distinct slot (Star1..Star4 by index) and ALWAYS redefine before reading, so a result never depends
 * on call order. astronomy-engine is pure JS (no WASM, no data files), so — like satellite.js — it is
 * an allowed import here even though this file imports nothing from react-native / expo / react (see
 * the src/ar/ eslint guard) so jest can exercise it on any platform.
 */

import { Body, DefineStar, Equator, Horizon, Observer, SearchHourAngle } from "astronomy-engine";
import { normalizeAzimuth } from "./geo";

/** Rest frequency of the neutral-hydrogen 21 cm line (MHz) — the canonical radio-astronomy target. */
export const HYDROGEN_LINE_MHZ = 1420.405751;

/** A fixed celestial radio source: J2000 position + display facts. */
export interface RadioSource {
  /** Stable key, e.g. "casA". */
  key: string;
  /** Full display name, e.g. "Cassiopeia A". */
  name: string;
  /** Short label for the AR chip / list, e.g. "Cas A". */
  short: string;
  /** J2000 right ascension in sidereal hours, [0, 24). */
  raHours: number;
  /** J2000 declination in degrees, [-90, 90]. */
  decDeg: number;
  /** Rough distance in light-years (fed to DefineStar's parallax term; display only otherwise). */
  distanceLy: number;
  /** Source class, e.g. "Supernova remnant". */
  kind: string;
  /** One-line description for the detail sheet. */
  blurb: string;
}

/** Observer position for the ephemeris: geodetic lat/lon (deg) + optional altitude (metres). */
export interface RadioObserver {
  lat: number;
  lon: number;
  alt?: number;
}

/** A fixed radio source reduced to observer-relative look angles at a single instant. */
export interface RadioTargetView {
  /** Stable key (matches the source), e.g. "casA". */
  key: string;
  /** Full display name. */
  name: string;
  /** Short label for the AR chip / list. */
  short: string;
  /** Azimuth in degrees, 0 = North, clockwise, [0, 360). */
  azimuthDeg: number;
  /** Apparent elevation in degrees above the horizon (refraction-corrected), [-90, 90]. */
  elevationDeg: number;
  /** J2000 right ascension in sidereal hours (carried through for the detail sheet). */
  raHours: number;
  /** J2000 declination in degrees (carried through for the detail sheet). */
  decDeg: number;
  /** Source class, e.g. "Radio galaxy". */
  kind: string;
}

/**
 * The four sources we track, in a fixed brightness/interest order. Positions are J2000 (EQJ), the frame
 * `DefineStar` expects. Distances are order-of-magnitude — they only feed DefineStar's tiny parallax
 * term (negligible at these ranges) and the sheet's readout.
 */
export const RADIO_SOURCES: RadioSource[] = [
  {
    key: "sgrA",
    name: "Sagittarius A*",
    short: "Sgr A*",
    raHours: 17.7611,
    decDeg: -29.0078,
    distanceLy: 26000,
    kind: "Galactic center",
    blurb: "The Milky Way's central supermassive black hole — the brightest region toward the galactic core.",
  },
  {
    key: "casA",
    name: "Cassiopeia A",
    short: "Cas A",
    raHours: 23.3906,
    decDeg: 58.815,
    distanceLy: 11000,
    kind: "Supernova remnant",
    blurb: "The brightest radio source in the sky beyond the Sun — a ~350-year-old supernova remnant.",
  },
  {
    key: "cygA",
    name: "Cygnus A",
    short: "Cyg A",
    raHours: 19.9912,
    decDeg: 40.7339,
    distanceLy: 600e6,
    kind: "Radio galaxy",
    blurb: "A textbook double-lobed radio galaxy — one of the strongest extragalactic sources.",
  },
  {
    key: "tauA",
    name: "Crab Nebula (M1)",
    short: "Tau A",
    raHours: 5.5755,
    decDeg: 22.0145,
    distanceLy: 6500,
    kind: "Supernova remnant",
    blurb: "The Crab — a supernova remnant with a central pulsar, a standard radio/X-ray calibrator.",
  },
];

/**
 * Fixed astronomy-engine "star" slots, one per source by index (Star1..Star4). `DefineStar` writes a
 * shared global slot, so we always redefine before reading; assigning a stable distinct slot per source
 * keeps that discipline obvious. Star8 is left as a spare for an ad-hoc (off-list) source.
 */
const RADIO_SLOTS: Body[] = [Body.Star1, Body.Star2, Body.Star3, Body.Star4];

/** Build the astronomy-engine Observer from our lat/lon/alt shape (alt defaults to sea level). */
function toObserver(observer: RadioObserver): Observer {
  return new Observer(observer.lat, observer.lon, observer.alt ?? 0);
}

/**
 * Compute observer-relative look angles for every fixed radio source at `date`. For each source we
 * `DefineStar` its J2000 RA/Dec into a stable slot, then run the SAME reduction planets.ts uses:
 * `Equator(star, date, observer, ofdate=true, aberration=true)` → apparent RA/Dec of date, fed to
 * `Horizon(..., "normal")` for refraction-corrected azimuth/altitude. Returns ALL four (INCLUDING
 * below-horizon); the hook filters to the visible set. Redefining the slot before each read makes the
 * result independent of call order despite `DefineStar`'s shared global slots.
 */
export function computeRadioSky(observer: RadioObserver, date: Date): RadioTargetView[] {
  const obs = toObserver(observer);
  const views: RadioTargetView[] = [];
  RADIO_SOURCES.forEach((src, i) => {
    const slot = RADIO_SLOTS[i];
    DefineStar(slot, src.raHours, src.decDeg, src.distanceLy);
    const eq = Equator(slot, date, obs, true, true);
    const hor = Horizon(date, obs, eq.ra, eq.dec, "normal");
    views.push({
      key: src.key,
      name: src.name,
      short: src.short,
      azimuthDeg: normalizeAzimuth(hor.azimuth),
      elevationDeg: hor.altitude,
      raHours: src.raHours,
      decDeg: src.decDeg,
      kind: src.kind,
    });
  });
  return views;
}

/**
 * Predict the next meridian transit (culmination) of `source` over `observer` at or after `fromDate`,
 * via `SearchHourAngle(star, observer, 0, fromDate, +1)` (hour angle 0 = the highest point in the day).
 * The event carries the transit time (`t.time.date`) and the apparent horizontal coordinates (`t.hor`),
 * of which we return the altitude. A fixed source's best altitude is `90 - |lat - dec|`; when that never
 * clears the horizon the source never rises, and we return null rather than a below-horizon "transit".
 * `DefineStar` first so the search targets this source's fixed position. Pure + deterministic.
 */
export function nextRadioTransit(
  source: RadioSource,
  observer: RadioObserver,
  fromDate: Date,
): { date: Date; altitudeDeg: number } | null {
  if (90 - Math.abs(observer.lat - source.decDeg) <= 0) return null; // never rises at this latitude
  const obs = toObserver(observer);
  const i = RADIO_SOURCES.findIndex((s) => s.key === source.key);
  const slot = i >= 0 ? RADIO_SLOTS[i] : Body.Star8; // spare slot for an off-list ad-hoc source
  DefineStar(slot, source.raHours, source.decDeg, source.distanceLy);
  const t = SearchHourAngle(slot, obs, 0, fromDate, +1);
  return { date: t.time.date, altitudeDeg: t.hor.altitude };
}
