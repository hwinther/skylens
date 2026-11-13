/**
 * Cockpit-view map aids: minimap zoom per object and altitude, airport label ranges per class, the
 * satellite opt-out, the distance used to decide when to refetch airports, and how airports/ports
 * become 3D labels (shared by the web screen and the Android globe).
 */

import {
  AIRPORT_FETCH_RADIUS_KM,
  airportLabelRangeM,
  airportOverlayItems,
  airportPlaces,
  bearingDeg,
  distanceKm,
  FERRY_COLOR,
  minimapZoom,
  PORT_FETCH_RADIUS_KM,
  portLabelRangeM,
  portOverlayItems,
  portPlaces,
  showsAirportOverlay,
  showsPortOverlay,
} from "@/sim/overlay";
import { fetchOverlay, fetchOverlayItems } from "@/sim/overlayData";

test("the minimap zooms out with altitude and furthest for satellites", () => {
  expect(minimapZoom("vessel", 12)).toBe(12);
  expect(minimapZoom("aircraft", 300)).toBe(12); // helicopter / approach
  expect(minimapZoom("aircraft", 1500)).toBe(10);
  expect(minimapZoom("aircraft", 11_000)).toBe(8); // cruise
  expect(minimapZoom("satellite", 420_000)).toBe(2);
});

test("bigger airports are labelled from further away; heliports never", () => {
  const large = airportLabelRangeM("large_airport")!;
  const medium = airportLabelRangeM("medium_airport")!;
  const small = airportLabelRangeM("small_airport")!;
  expect(large).toBeGreaterThan(medium);
  expect(medium).toBeGreaterThan(small);
  expect(airportLabelRangeM("heliport")).toBeNull();
  expect(airportLabelRangeM("seaplane_base")).toBeNull();
});

test("no airport overlay from orbit", () => {
  expect(showsAirportOverlay("aircraft")).toBe(true);
  expect(showsAirportOverlay("vessel")).toBe(true);
  expect(showsAirportOverlay("satellite")).toBe(false);
});

test("distanceKm is a plain haversine", () => {
  expect(distanceKm(59.9, 10.7, 59.9, 10.7)).toBe(0);
  // Oslo Gardermoen ↔ Oslo centre is ~36.6 km as the crow flies.
  const d = distanceKm(60.1939, 11.1004, 59.9139, 10.7522);
  expect(d).toBeGreaterThan(36);
  expect(d).toBeLessThan(37);
});

test("commercial ports show from furthest, marinas only close in; none from orbit", () => {
  expect(portLabelRangeM("port")).toBeGreaterThan(portLabelRangeM("harbour"));
  expect(portLabelRangeM("harbour")).toBeGreaterThan(portLabelRangeM("ferry"));
  expect(portLabelRangeM("ferry")).toBeGreaterThan(portLabelRangeM("marina"));
  expect(showsPortOverlay("vessel")).toBe(true);
  expect(showsPortOverlay("satellite")).toBe(false);
});

test("airports become 3D labels by class: large ones bigger, heliports left out", () => {
  const base = { name: "x", lat: 60, lon: 11, runways: [], frequencies: [] };
  const items = airportOverlayItems([
    { ...base, ident: "ENGM", type: "large_airport", elevationFt: 681 },
    { ...base, ident: "ENKJ", type: "small_airport" },
    { ...base, ident: "NO-0001", type: "heliport" },
  ]);
  expect(items.map((i) => i.label)).toEqual(["ENGM", "ENKJ"]);
  expect(items[0]).toMatchObject({ pixelSize: 9, rangeM: 150_000 });
  expect(items[0].altM).toBeCloseTo(681 * 0.3048 + 20);
  expect(items[1]).toMatchObject({ pixelSize: 6, altM: 20 });
});

test("ports: named ones keep their name, unnamed commercial ports their kind, other unnamed ones a dot", () => {
  const items = portOverlayItems([
    { id: "1", kind: "marina", lat: 59, lon: 10, name: "Aker Brygge" },
    { id: "2", kind: "port", lat: 59, lon: 10 },
    { id: "3", kind: "ferry", lat: 59, lon: 10, name: "  " },
  ]);
  expect(items.map((i) => i.label)).toEqual(["Aker Brygge", "Port", ""]);
  expect(items[1].pixelSize).toBe(8);
  expect(items.every((i) => i.altM === 8)).toBe(true);
});

test("fetchOverlayItems asks the right endpoint with the layer's radius", async () => {
  const client = {
    airports: jest.fn(() =>
      Promise.resolve({ airports: [{ ident: "ENGM", name: "", type: "large_airport", lat: 60, lon: 11, runways: [], frequencies: [] }] }),
    ),
    ports: jest.fn(() => Promise.resolve({ ports: [] })),
  };
  const airports = await fetchOverlayItems(client as never, "airports", 59.9, 10.75);
  expect(client.airports).toHaveBeenCalledWith(59.9, 10.75, AIRPORT_FETCH_RADIUS_KM);
  expect(airports).toHaveLength(1);
  await fetchOverlayItems(client as never, "ports", 59.9, 10.75);
  expect(client.ports).toHaveBeenCalledWith(59.9, 10.75, PORT_FETCH_RADIUS_KM);
});

test("ferry quays get their own filter group and colour; the other ports stay in the ports group", () => {
  const items = portOverlayItems([
    { id: "1", kind: "ferry", lat: 59, lon: 10, name: "Nesodden ferjekai" },
    { id: "2", kind: "harbour", lat: 59, lon: 10, name: "Drøbak" },
    { id: "3", kind: "marina", lat: 59, lon: 10 },
  ]);
  expect(items.map((i) => i.group)).toEqual(["ferries", "ports", "ports"]);
  expect(items[0].color).toBe(FERRY_COLOR);
  expect(items[1].color).toBeUndefined();
  expect(airportOverlayItems([{ ident: "ENGM", name: "", type: "large_airport", lat: 60, lon: 11, runways: [], frequencies: [] }])[0].group).toBe(
    "airports",
  );
});

test("places: the labelled airport classes with their ident, ports with ferry quays kept apart", () => {
  const base = { lat: 60, lon: 11, runways: [], frequencies: [] };
  expect(
    airportPlaces([
      { ...base, ident: "ENGM", name: "Oslo Gardermoen", type: "large_airport", elevationFt: 681 },
      { ...base, ident: "NO-0001", name: "Helipad", type: "heliport" },
    ]),
  ).toEqual([{ kind: "airport", code: "ENGM", name: "Oslo Gardermoen", lat: 60, lon: 11, altM: 681 * 0.3048 }]);
  expect(
    portPlaces([
      { id: "1", kind: "ferry", lat: 59, lon: 10, name: "Nesodden" },
      { id: "2", kind: "port", lat: 59, lon: 10 },
    ]).map((p) => [p.kind, p.name]),
  ).toEqual([
    ["ferry", "Nesodden"],
    ["port", "Port"],
  ]);
});

test("fetchOverlay returns the labels and the places from one request", async () => {
  const client = {
    airports: jest.fn(),
    ports: jest.fn(() => Promise.resolve({ ports: [{ id: "1", kind: "ferry", lat: 59, lon: 10, name: "Q" }] })),
  };
  const r = await fetchOverlay(client as never, "ports", 59.9, 10.75);
  expect(client.ports).toHaveBeenCalledTimes(1);
  expect(r.items).toHaveLength(1);
  expect(r.places).toEqual([{ kind: "ferry", code: "", name: "Q", lat: 59, lon: 10, altM: 0 }]);
});

test("bearingDeg: the initial great-circle bearing", () => {
  expect(bearingDeg(60, 10, 61, 10)).toBeCloseTo(0, 5);
  expect(bearingDeg(60, 10, 60, 11)).toBeGreaterThan(89);
  expect(bearingDeg(60, 10, 60, 11)).toBeLessThan(91);
  expect(bearingDeg(60, 10, 59, 10)).toBeCloseTo(180, 5);
  expect(bearingDeg(0, 10, 0, 9)).toBeCloseTo(270, 5);
});
