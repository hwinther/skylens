/**
 * Cockpit-view place card (pure parts): what a tap picked (traffic wins over a label under the same
 * pointer), which fetched place a picked label stands for, the card's wording, and where the card goes
 * so the bottom controls never sit under it.
 */

import { airportOverlayItems, airportPlaces, portOverlayItems, portPlaces, type OverlayPlace } from "@/sim/overlay";
import { CARD_GAP, PLACE_CARD_MAX_WIDTH, placeCardInset, placeCardWidth } from "@/sim/layout";
import {
  findPlaceByKey,
  isPlacePick,
  placeDetailText,
  placeHint,
  placeKindText,
  placeRangeText,
  resolveSimPick,
} from "@/sim/place";

const traffic = { id: { simTraffic: true, kind: "aircraft", id: "def456" } };
const vessel = { id: { simTraffic: true, kind: "vessel", id: "257000001" } };
const label = (key: string) => ({ id: { simPlace: true, key } });

describe("resolveSimPick", () => {
  test("a label alone opens its place", () => {
    expect(resolveSimPick([label("airport:ENGM")])).toEqual({ kind: "place", id: "airport:ENGM" });
  });

  test("traffic wins over a place wherever it is in the hits", () => {
    expect(resolveSimPick([label("airport:ENGM"), traffic])).toEqual({ kind: "aircraft", id: "def456" });
    expect(resolveSimPick([vessel, label("port:n1")])).toEqual({ kind: "vessel", id: "257000001" });
  });

  test("the first place wins among places", () => {
    expect(resolveSimPick([label("port:n1"), label("airport:ENGM")])).toEqual({ kind: "place", id: "port:n1" });
  });

  test("the globe, the route line and malformed ids pick nothing", () => {
    expect(resolveSimPick([])).toBeNull();
    expect(resolveSimPick([undefined, null, {}, { id: "a string" }, { id: { simPlace: true, key: "" } }])).toBeNull();
    expect(resolveSimPick([{ id: { simTraffic: true, kind: "satellite", id: "25544" } }])).toBeNull();
    expect(resolveSimPick([{ primitive: {} }])).toBeNull();
  });

  test("isPlacePick tells the two apart", () => {
    expect(isPlacePick({ kind: "place", id: "x" })).toBe(true);
    expect(isPlacePick({ kind: "aircraft", id: "x" })).toBe(false);
  });
});

describe("findPlaceByKey", () => {
  const airports = airportPlaces([
    { ident: "ENGM", iata: "OSL", name: "Oslo Airport, Gardermoen", type: "large_airport", lat: 60.19, lon: 11.1, runways: [], frequencies: [] },
  ]);
  const ports = portPlaces([{ id: "n1", kind: "ferry", lat: 59.9, lon: 10.7, name: "Nesodden" }]);

  test("resolves a label's key from either layer, with the same key the label carries", () => {
    const items = [
      ...airportOverlayItems([
        { ident: "ENGM", name: "Oslo Airport, Gardermoen", type: "large_airport", lat: 60.19, lon: 11.1, runways: [], frequencies: [] },
      ]),
      ...portOverlayItems([{ id: "n1", kind: "ferry", lat: 59.9, lon: 10.7, name: "Nesodden" }]),
    ];
    expect(findPlaceByKey({ airports, ports }, items[0].key!)?.name).toBe("Oslo Airport, Gardermoen");
    expect(findPlaceByKey({ airports, ports }, items[1].key!)?.name).toBe("Nesodden");
  });

  test("an unknown key (dropped by a refetch) or an empty one finds nothing", () => {
    expect(findPlaceByKey({ airports, ports }, "airport:ESSA")).toBeNull();
    expect(findPlaceByKey({ airports, ports }, "")).toBeNull();
    expect(findPlaceByKey({}, "airport:ENGM")).toBeNull();
  });
});

describe("wording", () => {
  const engm: OverlayPlace = {
    kind: "airport",
    code: "ENGM",
    name: "Oslo Airport, Gardermoen",
    lat: 60.1939,
    lon: 11.1004,
    altM: 208,
    typeLabel: "Large airport",
    iata: "OSL",
    municipality: "Oslo",
  };
  const quay: OverlayPlace = { kind: "ferry", code: "", name: "Nesodden", lat: 59.87, lon: 10.65, altM: 0 };

  test("kind: the dataset's type in words, else the kind alone", () => {
    expect(placeKindText(engm)).toBe("Large airport");
    expect(placeKindText(quay)).toBe("Ferry quay");
    expect(placeKindText({ ...quay, kind: "port" })).toBe("Port");
    expect(placeKindText({ ...engm, typeLabel: undefined })).toBe("Airport");
    expect(placeKindText({ ...quay, typeLabel: "Harbour", kind: "port" })).toBe("Harbour");
  });

  test("detail line: kind, ident, IATA and town where known, without repeats", () => {
    expect(placeDetailText(engm)).toBe("Large airport · ENGM · OSL · Oslo");
    expect(placeDetailText({ ...engm, iata: undefined, municipality: undefined })).toBe("Large airport · ENGM");
    expect(placeDetailText({ ...engm, iata: "ENGM" })).toBe("Large airport · ENGM · Oslo");
    expect(placeDetailText(quay)).toBe("Ferry quay");
    // An unnamed port is titled by its kind: the detail line says it has no name rather than repeat it.
    expect(placeDetailText({ ...quay, kind: "port", name: "Port", typeLabel: "Port" })).toBe("Port · no name in the data");
  });

  test("distance and bearing from the followed object, compass and three-digit degrees", () => {
    // Gardermoen from just south of it, on its meridian: north, ~22 km.
    expect(placeRangeText(engm, { lat: 59.994, lon: 11.1004 })).toBe("22 km N · 000°");
    // Due east, close by: one decimal under 10 km.
    expect(placeRangeText(engm, { lat: 60.1939, lon: 11.0 })).toMatch(/^5\.\d km E · 09\d°$/);
    expect(placeRangeText(engm, { lat: 60.5, lon: 11.6 })).toMatch(/^\d+ km SW · 2\d\d°$/);
  });

  test("no range while the followed object has no position", () => {
    expect(placeRangeText(engm, null)).toBeNull();
    expect(placeRangeText(engm, { lat: Number.NaN, lon: 10 })).toBeNull();
  });

  test("hover hint: the full name and what it is", () => {
    expect(placeHint(engm)).toBe("Oslo Airport, Gardermoen · Large airport");
    expect(placeHint({ ...quay, name: "", code: "" })).toBe("Ferry quay");
  });
});

describe("place card layout", () => {
  test("compact: at most its max width, never past the side margins", () => {
    expect(placeCardWidth(1280, 16, 16)).toBe(PLACE_CARD_MAX_WIDTH);
    expect(placeCardWidth(320, 16, 16)).toBe(288);
    expect(placeCardWidth(20, 16, 16)).toBe(0);
  });

  test("a bottom control moves above the card only where they'd collide side by side", () => {
    // Phone: the card spans most of the width, the minimap (168 px) sits at the right → lifted.
    expect(placeCardInset({ cardRight: 16 + 340, cardHeight: 96, controlLeft: 412 - 16 - 168 })).toBe(96 + CARD_GAP);
    // Desktop: plenty of room between them → both stay on the bottom line.
    expect(placeCardInset({ cardRight: 16 + 340, cardHeight: 96, controlLeft: 1280 - 16 - 168 })).toBe(0);
    // Not measured yet → nothing to move.
    expect(placeCardInset({ cardRight: 356, cardHeight: 0, controlLeft: 100 })).toBe(0);
  });
});
