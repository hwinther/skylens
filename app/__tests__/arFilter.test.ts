import {
  AR_GROUPS,
  arFilterChips,
  arGroupVisibility,
  availableArGroups,
  DETAIL_GROUP,
  detailHiddenByFilter,
  hiddenArGroupCount,
  type ArLayers,
} from "@/state/arFilter";
import { toggleId } from "@/state/listFilter";

const ALL_ON: ArLayers = {
  showShips: true,
  showAton: true,
  showSatellites: true,
  showPlanets: true,
  showEcliptic: true,
  showRadioSky: true,
  showAirports: true,
};
const ALL_OFF: ArLayers = {
  showShips: false,
  showAton: false,
  showSatellites: false,
  showPlanets: false,
  showEcliptic: false,
  showRadioSky: false,
  showAirports: false,
};

describe("AR filter", () => {
  it("offers every group while its Settings layers are on, in panel order", () => {
    expect(availableArGroups(ALL_ON)).toEqual(["aircraft", "vessels", "satellites", "sky", "airports"]);
  });

  it("always offers aircraft (no Settings toggle) and leaves out groups whose layers are all off", () => {
    expect(availableArGroups(ALL_OFF)).toEqual(["aircraft"]);
  });

  it("offers a group while any one of its layers is on", () => {
    expect(availableArGroups({ ...ALL_OFF, showAton: true })).toEqual(["aircraft", "vessels"]);
    expect(availableArGroups({ ...ALL_OFF, showEcliptic: true })).toEqual(["aircraft", "sky"]);
    expect(availableArGroups({ ...ALL_OFF, showRadioSky: true })).toEqual(["aircraft", "sky"]);
  });

  it("draws an offered group unless it is hidden; a group off in Settings is never drawn", () => {
    const v = arGroupVisibility({ ...ALL_ON, showSatellites: false }, ["aircraft"]);
    expect(v).toEqual({ aircraft: false, vessels: true, satellites: false, sky: true, airports: true });
    expect(arGroupVisibility(ALL_ON, [])).toEqual(Object.fromEntries(AR_GROUPS.map((g) => [g, true])));
  });

  it("chips carry label, colour and pressed state, only for offered groups", () => {
    const chips = arFilterChips({ ...ALL_OFF, showShips: true }, ["vessels", "satellites"]);
    expect(chips.map((c) => [c.group, c.label, c.shown])).toEqual([
      ["aircraft", "Aircraft", true],
      ["vessels", "Vessels", false],
    ]);
    expect(chips.every((c) => typeof c.color === "string" && c.color.length > 0)).toBe(true);
  });

  it("counts only hidden groups that are offered (a hidden group off in Settings hides nothing)", () => {
    expect(hiddenArGroupCount(arFilterChips(ALL_ON, []))).toBe(0);
    expect(hiddenArGroupCount(arFilterChips(ALL_ON, ["aircraft", "sky"]))).toBe(2);
    expect(hiddenArGroupCount(arFilterChips({ ...ALL_ON, showSatellites: false }, ["satellites"]))).toBe(0);
  });

  it("toggling uses the shared canonical id list", () => {
    const once = toggleId([], "sky", AR_GROUPS);
    const twice = toggleId(once, "aircraft", AR_GROUPS);
    expect(twice).toEqual(["aircraft", "sky"]);
    expect(toggleId(twice, "sky", AR_GROUPS)).toEqual(["aircraft"]);
  });

  it("maps every detail card to the group its label is drawn in", () => {
    expect(DETAIL_GROUP).toEqual({
      aircraft: "aircraft",
      vessel: "vessels",
      satellite: "satellites",
      planet: "sky",
      radio: "sky",
      airport: "airports",
    });
  });

  it("says when the open card's object is no longer drawn", () => {
    const v = arGroupVisibility(ALL_ON, ["sky"]);
    expect(detailHiddenByFilter("planet", v)).toBe(true);
    expect(detailHiddenByFilter("radio", v)).toBe(true);
    expect(detailHiddenByFilter("aircraft", v)).toBe(false);
    expect(detailHiddenByFilter(null, v)).toBe(false);
    expect(detailHiddenByFilter(undefined, v)).toBe(false);
  });
});
