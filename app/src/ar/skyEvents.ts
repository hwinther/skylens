/**
 * Pure-TypeScript "upcoming sky events" feed for the List screen's Upcoming section.
 *
 * A chronological, offline, DETERMINISTIC function of (fromDate, observer): the next equinox/solstice,
 * locally-visible lunar & solar eclipses, outer-planet oppositions, Mercury/Venus greatest elongations
 * and supermoons (perigee full moons) — everything the naked eye or a small scope can look forward to.
 * All of it computed on-device with `astronomy-engine` (pure JS, no network, no element sets); no two
 * runs from the same inputs ever differ. This module owns that search: each event type is searched from
 * `fromDate`, the results merged, sorted ascending and capped, so the caller just renders a list.
 *
 * Taxonomy (`SkyEventKind`): seasons (equinox/solstice) and planetary geometry (opposition/elongation)
 * are observer-INDEPENDENT and always computed; eclipses are observer-LOCAL — lunar eclipses are kept
 * only when the Moon is above the observer's horizon at peak, and local solar eclipses are already
 * visibility-filtered by astronomy-engine. Supermoons are full moons coincident (< 1 day) with a near
 * perigee (< 360 000 km).
 *
 * astronomy-engine is pure JS (no WASM, no data files), so — like planets.ts/radioSky.ts — it is an
 * allowed import here even though this file imports nothing from react-native/expo/react (see the
 * src/ar/ eslint guard) so jest can exercise it on any platform.
 */

import {
  ApsisKind,
  Body,
  Equator,
  Horizon,
  NextLocalSolarEclipse,
  NextLunarApsis,
  NextLunarEclipse,
  NextMoonQuarter,
  Observer,
  Seasons,
  SearchLocalSolarEclipse,
  SearchLunarApsis,
  SearchLunarEclipse,
  SearchMaxElongation,
  SearchMoonQuarter,
  SearchRelativeLongitude,
} from "astronomy-engine";

/** The seven event families the feed surfaces. */
export type SkyEventKind =
  | "equinox"
  | "solstice"
  | "lunar-eclipse"
  | "solar-eclipse"
  | "opposition"
  | "elongation"
  | "supermoon";

/** One upcoming astronomical event, reduced to what the list row shows. */
export interface SkyEvent {
  /** Stable, unique key — `${kind}-${date.toISOString()}`. */
  key: string;
  kind: SkyEventKind;
  /** Row headline, e.g. "Mars at opposition". */
  title: string;
  /** One-line supporting detail, e.g. "Closest & brightest this year". */
  detail: string;
  /** Instant of the event (UTC). */
  date: Date;
}

/** Observer position for the visibility-gated events (eclipses): geodetic lat/lon (deg) + optional alt (m). */
export interface SkyEventObserver {
  lat: number;
  lon: number;
  alt?: number;
}

const DAY_MS = 86_400_000;

/**
 * Compute the upcoming sky events at or after `fromDate`. Each type is searched independently, merged,
 * sorted ascending by `date`, filtered to strictly after `fromDate`, then capped at `limit`. Seasons,
 * oppositions and elongations are computed even when `observer` is null (they don't need one); eclipses
 * are skipped without an observer. `horizonDays` (default 400) bounds the everyday events; local
 * eclipses are rare, so they search out to `eclipseHorizonDays` (default 1200) — far enough that the
 * next one always appears. Every per-type search is guarded, so one failing type never sinks the feed.
 */
export function computeSkyEvents(
  fromDate: Date,
  observer?: SkyEventObserver | null,
  opts?: { horizonDays?: number; eclipseHorizonDays?: number; limit?: number },
): SkyEvent[] {
  const horizonDays = opts?.horizonDays ?? 400;
  const eclipseHorizonDays = opts?.eclipseHorizonDays ?? 1200;
  const limit = opts?.limit ?? 15;
  const windowEnd = new Date(fromDate.getTime() + horizonDays * DAY_MS);
  const eclipseEnd = new Date(fromDate.getTime() + eclipseHorizonDays * DAY_MS);

  const events: SkyEvent[] = [];
  collectSeasons(fromDate, windowEnd, events);
  collectOppositions(fromDate, windowEnd, events);
  collectElongations(fromDate, windowEnd, events);
  collectSupermoons(fromDate, windowEnd, events);
  if (observer) {
    const obs = new Observer(observer.lat, observer.lon, observer.alt ?? 0);
    collectLunarEclipses(fromDate, eclipseEnd, obs, events);
    collectSolarEclipses(fromDate, eclipseEnd, obs, events);
  }

  return events
    .filter((e) => e.date.getTime() > fromDate.getTime())
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, limit);
}

/** Capitalise an EclipseKind ("total") for a title ("Total …"). */
function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Local wall-clock HH:MM of an instant — the eclipse detail's "when to look up". */
function localTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Push a built event, deriving its stable key from kind + instant. */
function emit(events: SkyEvent[], kind: SkyEventKind, title: string, detail: string, date: Date): void {
  events.push({ key: `${kind}-${date.toISOString()}`, kind, title, detail, date });
}

/** The four seasonal markers, in calendar order, with a northern-hemisphere flavour line. */
const SEASON_FIELDS = [
  { field: "mar_equinox", kind: "equinox", title: "March equinox", detail: "Day and night nearly equal" },
  { field: "jun_solstice", kind: "solstice", title: "June solstice", detail: "Longest day (N. hemisphere)" },
  { field: "sep_equinox", kind: "equinox", title: "September equinox", detail: "Day and night nearly equal" },
  { field: "dec_solstice", kind: "solstice", title: "December solstice", detail: "Shortest day (N. hemisphere)" },
] as const;

/**
 * Equinoxes & solstices — observer-independent. `Seasons(year)` returns the four `AstroTime`s for a
 * calendar year; we walk every year the window spans and emit the markers that fall inside it.
 */
function collectSeasons(from: Date, windowEnd: Date, events: SkyEvent[]): void {
  try {
    for (let year = from.getUTCFullYear(); year <= windowEnd.getUTCFullYear(); year++) {
      const s = Seasons(year);
      for (const { field, kind, title, detail } of SEASON_FIELDS) {
        const date = s[field].date;
        if (date > from && date <= windowEnd) emit(events, kind, title, detail, date);
      }
    }
  } catch {
    // A failed season search must not sink the whole feed — just skip seasons.
  }
}

/**
 * Outer-planet oppositions (Mars/Jupiter/Saturn) — observer-independent, the best viewing of the year.
 * NOTE: opposition of a SUPERIOR planet is `SearchRelativeLongitude(body, 0, …)`, not 180 — at
 * opposition the Earth and planet share a heliocentric ecliptic longitude (Earth passes between the Sun
 * and the planet). 180 would be superior conjunction (planet behind the Sun). Verified against the real
 * astronomy-engine .d.ts + known 2026–27 opposition dates.
 */
function collectOppositions(from: Date, windowEnd: Date, events: SkyEvent[]): void {
  const bodies: { body: Body; name: string }[] = [
    { body: Body.Mars, name: "Mars" },
    { body: Body.Jupiter, name: "Jupiter" },
    { body: Body.Saturn, name: "Saturn" },
  ];
  for (const { body, name } of bodies) {
    try {
      const date = SearchRelativeLongitude(body, 0, from).date;
      if (date > from && date <= windowEnd) {
        emit(events, "opposition", `${name} at opposition`, "Closest & brightest this year", date);
      }
    } catch {
      // Skip a single body whose search fails; the others still contribute.
    }
  }
}

/**
 * Greatest elongations of Mercury & Venus — observer-independent, their best separation from the Sun
 * (highest, easiest to spot). `SearchMaxElongation` gives the next one plus its angle and whether it's
 * a morning or evening apparition; the soonest each is enough within the window.
 */
function collectElongations(from: Date, windowEnd: Date, events: SkyEvent[]): void {
  const bodies: { body: Body; name: string }[] = [
    { body: Body.Mercury, name: "Mercury" },
    { body: Body.Venus, name: "Venus" },
  ];
  for (const { body, name } of bodies) {
    try {
      const e = SearchMaxElongation(body, from);
      const date = e.time.date;
      if (date > from && date <= windowEnd) {
        emit(
          events,
          "elongation",
          `${name} at greatest elongation`,
          `${Math.round(e.elongation)}° · ${e.visibility} sky`,
          date,
        );
      }
    } catch {
      // Skip a single body whose search fails.
    }
  }
}

/**
 * Supermoons — full moons coincident with a near perigee. Enumerate lunar quarters from `from` with
 * `SearchMoonQuarter`/`NextMoonQuarter` (quarter 2 = full moon; the enumerator never skips a month, which
 * a fixed 29.53-day advance can). For each full moon, find the nearest perigee (`SearchLunarApsis` then
 * `NextLunarApsis`, keeping `ApsisKind.Pericenter`); if it lands within a day AND under 360 000 km, the
 * full moon is a supermoon.
 */
function collectSupermoons(from: Date, windowEnd: Date, events: SkyEvent[]): void {
  try {
    let q = SearchMoonQuarter(from);
    for (let i = 0; i < 80 && q.time.date <= windowEnd; i++) {
      if (q.quarter === 2) {
        const full = q.time.date;
        const peri = nearestPerigee(full);
        if (peri) {
          const deltaDays = Math.abs(peri.time.date.getTime() - full.getTime()) / DAY_MS;
          if (deltaDays < 1 && peri.dist_km < 360_000) {
            emit(
              events,
              "supermoon",
              "Supermoon",
              `Perigee full moon · ${Math.round(peri.dist_km).toLocaleString()} km`,
              full,
            );
          }
        }
      }
      q = NextMoonQuarter(q);
    }
  } catch {
    // Skip supermoons if the quarter/apsis search fails.
  }
}

/** The perigee (lunar pericenter) closest in time to `full`, searching a few apsides around it. */
function nearestPerigee(full: Date): { time: { date: Date }; dist_km: number } | null {
  try {
    let ap = SearchLunarApsis(new Date(full.getTime() - 20 * DAY_MS));
    let best: { time: { date: Date }; dist_km: number } | null = null;
    let bestDelta = Infinity;
    for (let i = 0; i < 6; i++) {
      if (ap.kind === ApsisKind.Pericenter) {
        const delta = Math.abs(ap.time.date.getTime() - full.getTime());
        if (delta < bestDelta) {
          bestDelta = delta;
          best = ap;
        }
      }
      ap = NextLunarApsis(ap);
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Locally-visible lunar eclipses. `SearchLunarEclipse(from)` then `NextLunarEclipse(prev.peak)` walks the
 * series until past `eclipseEnd`. A lunar eclipse is only worth listing when the Moon is actually up:
 * reduce the Moon to an apparent altitude at peak via the SAME `Equator`(of-date)+`Horizon`("normal")
 * path planets.ts uses, and keep the event only if that altitude is above the horizon.
 */
function collectLunarEclipses(from: Date, eclipseEnd: Date, obs: Observer, events: SkyEvent[]): void {
  try {
    let e = SearchLunarEclipse(from);
    for (let i = 0; i < 40 && e.peak.date <= eclipseEnd; i++) {
      const peak = e.peak.date;
      const eq = Equator(Body.Moon, peak, obs, true, true);
      const hor = Horizon(peak, obs, eq.ra, eq.dec, "normal");
      if (Number.isFinite(hor.altitude) && hor.altitude > 0) {
        emit(
          events,
          "lunar-eclipse",
          `${cap(e.kind)} lunar eclipse`,
          `Moon up · ${localTime(peak)}`,
          peak,
        );
      }
      e = NextLunarEclipse(e.peak);
    }
  } catch {
    // Skip lunar eclipses if the series search fails.
  }
}

/**
 * Locally-visible solar eclipses. `SearchLocalSolarEclipse(from, observer)` then
 * `NextLocalSolarEclipse(prev.peak.time, observer)` walks the series until past `eclipseEnd`. These are
 * ALREADY observer-local (astronomy-engine returns only eclipses touching this location), so all are
 * included; `obscuration` (0..1) gives how much of the Sun is covered at peak.
 */
function collectSolarEclipses(from: Date, eclipseEnd: Date, obs: Observer, events: SkyEvent[]): void {
  try {
    let e = SearchLocalSolarEclipse(from, obs);
    for (let i = 0; i < 40 && e.peak.time.date <= eclipseEnd; i++) {
      const peak = e.peak.time.date;
      const pct = Math.round((e.obscuration ?? 0) * 100);
      emit(
        events,
        "solar-eclipse",
        `${cap(e.kind)} solar eclipse`,
        `${pct}% covered · ${localTime(peak)}`,
        peak,
      );
      e = NextLocalSolarEclipse(e.peak.time, obs);
    }
  } catch {
    // Skip solar eclipses if the series search fails.
  }
}
