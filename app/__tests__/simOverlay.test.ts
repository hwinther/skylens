/**
 * Cockpit-view map aids: minimap zoom per object and altitude, airport label ranges per class, the
 * satellite opt-out, and the distance used to decide when to refetch airports.
 */

import {
  airportLabelRangeM,
  distanceKm,
  minimapZoom,
  portLabelRangeM,
  showsAirportOverlay,
  showsPortOverlay,
} from "@/sim/overlay";

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
