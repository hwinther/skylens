/**
 * List tab filter + accordion rules (state/listFilter): which chips exist for the layer toggles, what
 * the filter hides, how section counts follow, and that stored id lists are sanitised on load.
 */
import {
  LIST_KINDS,
  LIST_SECTIONS,
  availableKinds,
  listView,
  sanitizeIds,
  toggleId,
  trafficBreakdown,
  type ListLayers,
} from "@/state/listFilter";

const ALL_ON: ListLayers = {
  showShips: true,
  showAton: true,
  showSatellites: true,
  showPlanets: true,
  showRadioSky: true,
  showSkyEvents: true,
};
const COUNTS = { air: 5, sea: 3, satellites: 4, sky: 2, radio: 1, events: 6 };

describe("availableKinds", () => {
  it("offers every kind when every layer is on, in bar order", () => {
    expect(availableKinds(ALL_ON)).toEqual(["air", "sea", "satellites", "sky", "radio", "events"]);
  });

  it("drops the kinds whose layer is off; Air has no toggle and always stays", () => {
    const none = {
      showShips: false,
      showAton: false,
      showSatellites: false,
      showPlanets: false,
      showRadioSky: false,
      showSkyEvents: false,
    };
    expect(availableKinds(none)).toEqual(["air"]);
  });

  it("keeps Sea while either ships or aids to navigation are on", () => {
    expect(availableKinds({ ...ALL_ON, showShips: false })).toContain("sea");
    expect(availableKinds({ ...ALL_ON, showAton: false })).toContain("sea");
    expect(availableKinds({ ...ALL_ON, showShips: false, showAton: false })).not.toContain("sea");
  });
});

describe("listView", () => {
  const view = (over: Partial<Parameters<typeof listView>[0]> = {}) =>
    listView({ layers: ALL_ON, hidden: [], collapsed: [], counts: COUNTS, ...over });

  it("shows everything, expanded, with per-kind chip counts by default", () => {
    const v = view();
    expect(v.chips.map((c) => [c.kind, c.count, c.shown])).toEqual([
      ["air", 5, true],
      ["sea", 3, true],
      ["satellites", 4, true],
      ["sky", 2, true],
      ["radio", 1, true],
      ["events", 6, true],
    ]);
    expect(v.sections.traffic).toEqual({ visible: true, expanded: true, count: 8 });
    expect(v.allFiltered).toBe(false);
  });

  it("hiding Sea keeps Traffic with only the aircraft counted; the chip keeps its count", () => {
    const v = view({ hidden: ["sea"] });
    expect(v.shown.sea).toBe(false);
    expect(v.sections.traffic).toEqual({ visible: true, expanded: true, count: 5 });
    expect(v.chips.find((c) => c.kind === "sea")).toMatchObject({ shown: false, count: 3 });
  });

  it("hiding every kind of a section removes the section", () => {
    const v = view({ hidden: ["air", "sea", "radio"] });
    expect(v.sections.traffic.visible).toBe(false);
    expect(v.sections.radio.visible).toBe(false);
    expect(v.sections.overhead.visible).toBe(true);
    expect(v.allFiltered).toBe(false);
  });

  it("a layer switched off in Settings has no chip and no section, whatever the filter says", () => {
    const v = view({ layers: { ...ALL_ON, showRadioSky: false }, hidden: [] });
    expect(v.chips.map((c) => c.kind)).not.toContain("radio");
    expect(v.sections.radio.visible).toBe(false);
  });

  it("is all-filtered only when every available kind is hidden", () => {
    const layers = { ...ALL_ON, showSatellites: false, showPlanets: false, showRadioSky: false, showSkyEvents: false };
    expect(view({ layers, hidden: ["air"] }).allFiltered).toBe(false);
    // Kinds whose layer is off do not need hiding.
    expect(view({ layers, hidden: ["air", "sea"] }).allFiltered).toBe(true);
    expect(view({ hidden: [...LIST_KINDS] }).allFiltered).toBe(true);
  });

  it("collapsing a section keeps it visible with its count", () => {
    const v = view({ collapsed: ["overhead"] });
    expect(v.sections.overhead).toEqual({ visible: true, expanded: false, count: 4 });
    expect(v.sections.traffic.expanded).toBe(true);
  });
});

describe("trafficBreakdown", () => {
  const shown = (air: boolean, sea: boolean) =>
    ({ air, sea, satellites: true, sky: true, radio: true, events: true }) as const;
  it("lists the shown families only", () => {
    expect(trafficBreakdown(shown(true, true), COUNTS)).toBe("5 air · 3 sea");
    expect(trafficBreakdown(shown(true, false), COUNTS)).toBe("5 air");
    expect(trafficBreakdown(shown(false, true), COUNTS)).toBe("3 sea");
  });
});

describe("stored id lists", () => {
  it("sanitizeIds keeps the known ids once, in canonical order, and ignores the rest", () => {
    expect(sanitizeIds(["radio", "planes", "air", "air", 7], LIST_KINDS)).toEqual(["air", "radio"]);
    expect(sanitizeIds(undefined, LIST_SECTIONS)).toEqual([]);
    expect(sanitizeIds("traffic", LIST_SECTIONS)).toEqual([]);
  });

  it("toggleId adds and removes", () => {
    expect(toggleId([], "sea", LIST_KINDS)).toEqual(["sea"]);
    expect(toggleId(["sea", "air"], "sea", LIST_KINDS)).toEqual(["air"]);
    expect(toggleId(["events"], "traffic" as never, LIST_KINDS)).toEqual(["events"]);
  });
});
