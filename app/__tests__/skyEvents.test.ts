/**
 * Pure upcoming-sky-events feed. Like the planet/radio tests, astronomy-engine is a deterministic
 * function of (date, observer) with no external state, so a FIXED `FROM` yields a fixed event set that
 * is cross-checkable against JPL Horizons / almanacs. Bounds are kept LOOSE (real astronomical dates
 * shift year to year); the pins assert taxonomy, ordering and the observer-gating contract rather than
 * exact instants — except the one season cross-check, which must equal astronomy-engine's own `Seasons`.
 *
 * In this window (FROM 2026-07-15, default horizon 400 d / eclipse horizon 1200 d, cap 15) the feed
 * happens to contain — in order — a Mercury elongation, a local partial solar eclipse, a Venus
 * elongation, the September equinox, Saturn/Jupiter/Mars oppositions, the December solstice, two
 * supermoons (2026-12-24, 2027-01-22), an up penumbral lunar eclipse, and the March/June markers, so
 * all seven kinds are exercised.
 */

import * as Astro from "astronomy-engine";
import { computeSkyEvents } from "@/ar/skyEvents";

const DAY_MS = 86_400_000;

// Oslo-ish. Chosen so the September equinox sits ~70 days out (inside the 95-day season assertion) and
// several of each planetary/eclipse kind fall inside the default horizons.
const FROM = new Date("2026-07-15T00:00:00Z");
const OBSERVER = { lat: 59.9, lon: 10.7, alt: 100 };

describe("computeSkyEvents — with an observer (Oslo, fixed instant)", () => {
  const events = computeSkyEvents(FROM, OBSERVER);

  it("returns a non-empty, ascending, after-FROM list capped at the limit", () => {
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThanOrEqual(15); // default cap
    for (const e of events) {
      // The feed drops anything at or before FROM — everything here is genuinely upcoming.
      expect(e.date.getTime()).toBeGreaterThan(FROM.getTime());
    }
    for (let i = 1; i < events.length; i++) {
      // Sorted ascending by date so the list reads as a timeline.
      expect(events[i].date.getTime()).toBeGreaterThanOrEqual(events[i - 1].date.getTime());
    }
  });

  it("always lists a season within ~95 days, matching astronomy-engine's own Seasons()", () => {
    // There is an equinox/solstice every ~3 months, so one must always fall inside 95 days of any FROM
    // (here: the September equinox ≈ 70 days out).
    const seasons = events.filter(
      (e) =>
        (e.kind === "equinox" || e.kind === "solstice") &&
        e.date.getTime() - FROM.getTime() <= 95 * DAY_MS,
    );
    expect(seasons.length).toBeGreaterThanOrEqual(1);
    // Cross-check the instant: the module derives seasons straight from Seasons(year), so the event's
    // date must equal one of that year's four season fields EXACTLY (not just "close").
    const season = seasons[0];
    const s = Astro.Seasons(season.date.getUTCFullYear());
    const fields = [s.mar_equinox, s.jun_solstice, s.sep_equinox, s.dec_solstice].map((t) =>
      t.date.getTime(),
    );
    expect(fields).toContain(season.date.getTime());
  });

  it("contains at least one planetary highlight (opposition or elongation)", () => {
    // Outer-planet oppositions + Mercury/Venus elongations are frequent enough that ≥1 always lands
    // inside the 400-day horizon (here: multiple).
    const planetary = events.filter((e) => e.kind === "opposition" || e.kind === "elongation");
    expect(planetary.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps every eclipse row inside the eclipse horizon", () => {
    // Eclipses search out to eclipseHorizonDays (1200), further than the everyday horizon; none may
    // exceed it. (Loose: which eclipses appear depends on real dates + local visibility.)
    const eclipses = events.filter((e) => e.kind === "lunar-eclipse" || e.kind === "solar-eclipse");
    for (const e of eclipses) {
      expect(e.date.getTime() - FROM.getTime()).toBeLessThanOrEqual(1200 * DAY_MS);
    }
  });

  it("shapes any supermoon row as a perigee full moon with a km distance", () => {
    // Don't hard-require a supermoon in the fixed window; only assert the shape of any that appear
    // (this window happens to include two). This unit-tests the supermoon predicate's output indirectly.
    for (const e of events.filter((x) => x.kind === "supermoon")) {
      expect(e.title).toBe("Supermoon");
      expect(e.detail).toContain("km");
      expect(e.detail.toLowerCase()).toContain("perigee");
    }
  });

  it("emits unique keys", () => {
    const keys = events.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("computeSkyEvents — without an observer", () => {
  it("still yields observer-independent events but omits the visibility-gated eclipses", () => {
    // Seasons / oppositions / elongations don't need a location; eclipses do (lunar via horizon check,
    // solar via SearchLocalSolarEclipse), so with no observer they must be absent entirely.
    const events = computeSkyEvents(FROM); // observer omitted
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === "equinox" || e.kind === "solstice")).toBe(true);
    expect(events.some((e) => e.kind === "opposition" || e.kind === "elongation")).toBe(true);
    expect(events.some((e) => e.kind === "lunar-eclipse")).toBe(false);
    expect(events.some((e) => e.kind === "solar-eclipse")).toBe(false);
    // Still ascending + after FROM without an observer.
    for (const e of events) expect(e.date.getTime()).toBeGreaterThan(FROM.getTime());
    for (let i = 1; i < events.length; i++) {
      expect(events[i].date.getTime()).toBeGreaterThanOrEqual(events[i - 1].date.getTime());
    }
  });
});
