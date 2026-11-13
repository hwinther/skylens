/**
 * The cockpit route line from any distance: long great circles get enough points to follow the globe
 * (src/sim/route.ts), and a destination beyond the nearby airports is resolved by one offline lookup
 * per code, remembered success or failure, never while the API gate is closed (src/sim/airportLookup.ts).
 */
import type { AirportDto } from "@/api/types";
import { AirportLookup } from "@/sim/airportLookup";
import { distanceKm } from "@/sim/overlay";
import {
  airportLookupCode,
  airportPlace,
  greatCirclePoints,
  ROUTE_MAX_SEGMENT_KM,
  ROUTE_MAX_SEGMENTS,
  ROUTE_SEGMENTS,
  routeSegments,
} from "@/sim/route";

const JFK: AirportDto = {
  ident: "KJFK",
  iata: "JFK",
  name: "John F Kennedy International Airport",
  type: "large_airport",
  lat: 40.6398,
  lon: -73.7789,
  elevationFt: 13,
  runways: [],
  frequencies: [],
};

describe("route line sampling", () => {
  it("keeps short hops at the minimum and splits long lines into short chords, capped", () => {
    expect(routeSegments(40)).toBe(ROUTE_SEGMENTS);
    expect(routeSegments(0)).toBe(ROUTE_SEGMENTS);
    expect(routeSegments(Number.NaN)).toBe(ROUTE_SEGMENTS);
    expect(routeSegments(5000)).toBe(200);
    expect(routeSegments(20_000)).toBe(ROUTE_MAX_SEGMENTS);
  });

  it("samples an Oslo → New York line every ROUTE_MAX_SEGMENT_KM at most, so it hugs the globe", () => {
    const a = { lat: 60.19, lon: 11.1, altM: 11000 };
    const b = { lat: JFK.lat, lon: JFK.lon, altM: 4 };
    const pts = greatCirclePoints(a, b);
    const total = distanceKm(a.lat, a.lon, b.lat, b.lon);
    expect(pts.length - 1).toBe(routeSegments(total));
    const seg = distanceKm(pts[0].lat, pts[0].lon, pts[1].lat, pts[1].lon);
    expect(seg).toBeLessThanOrEqual(ROUTE_MAX_SEGMENT_KM);
    // A chord that short sags only metres below the surface (len² / 8R).
    expect(((seg * seg) / (8 * 6371)) * 1000).toBeLessThan(15);
    expect(pts[pts.length - 1].lon).toBeCloseTo(b.lon, 6);
    // The great circle goes far north of both ends (over Greenland's latitudes), not along the rhumb line.
    expect(Math.max(...pts.map((p) => p.lat))).toBeGreaterThan(60.19);
  });

  it("an explicit segment count still wins", () => {
    expect(greatCirclePoints({ lat: 60, lon: 10, altM: 0 }, { lat: 40, lon: -70, altM: 0 }, 8)).toHaveLength(9);
  });
});

describe("airport codes and places", () => {
  it("normalises plausible idents and rejects the rest", () => {
    expect(airportLookupCode(" kjfk ")).toBe("KJFK");
    expect(airportLookupCode("NO-0003")).toBe("NO-0003");
    expect(airportLookupCode("JF")).toBeNull();
    expect(airportLookupCode("K JFK")).toBeNull();
    expect(airportLookupCode("../x")).toBeNull();
    expect(airportLookupCode(null)).toBeNull();
  });

  it("turns any airport (not only the labelled classes) into a place at field elevation", () => {
    expect(airportPlace({ ...JFK, elevationFt: 100 })).toEqual({
      kind: "airport",
      code: "KJFK",
      name: JFK.name,
      lat: JFK.lat,
      lon: JFK.lon,
      altM: 30.48,
    });
    expect(airportPlace({ ...JFK, elevationFt: null }).altM).toBe(0);
  });
});

describe("AirportLookup", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("fetches a code once, then answers from memory", async () => {
    const fetchAirport = jest.fn((ident: string) => Promise.resolve(ident === "KJFK" ? JFK : null));
    const lookup = new AirportLookup({ fetchAirport, allowed: () => true });

    expect(lookup.resolve("kjfk")).toBe("pending");
    expect(lookup.resolve("KJFK")).toBe("pending"); // in flight: not asked again
    await flush();
    expect(lookup.resolve(" KJFK ")).toMatchObject({ code: "KJFK", lat: JFK.lat });
    expect(fetchAirport).toHaveBeenCalledTimes(1);
    expect(fetchAirport).toHaveBeenCalledWith("KJFK");
  });

  it("remembers an unknown code (404) and a failure as no place, without retrying", async () => {
    const fetchAirport = jest.fn((ident: string) =>
      ident === "ZZZZ" ? Promise.resolve(null) : Promise.reject(new Error("offline")),
    );
    const lookup = new AirportLookup({ fetchAirport, allowed: () => true });
    lookup.resolve("ZZZZ");
    lookup.resolve("EGLL");
    await flush();
    for (let i = 0; i < 5; i++) {
      expect(lookup.resolve("ZZZZ")).toBeNull();
      expect(lookup.resolve("EGLL")).toBeNull();
    }
    expect(fetchAirport).toHaveBeenCalledTimes(2);
  });

  it("asks nothing while the API gate is closed, and does once it opens", async () => {
    let allowed = false;
    const fetchAirport = jest.fn(() => Promise.resolve(JFK));
    const lookup = new AirportLookup({ fetchAirport, allowed: () => allowed });
    expect(lookup.resolve("KJFK")).toBeUndefined();
    expect(fetchAirport).not.toHaveBeenCalled();

    allowed = true;
    expect(lookup.resolve("KJFK")).toBe("pending");
    await flush();
    expect(lookup.resolve("KJFK")).toMatchObject({ code: "KJFK" });
    expect(fetchAirport).toHaveBeenCalledTimes(1);
  });

  it("never fetches a malformed code", () => {
    const fetchAirport = jest.fn(() => Promise.resolve(JFK));
    const lookup = new AirportLookup({ fetchAirport, allowed: () => true });
    expect(lookup.resolve("?")).toBeNull();
    expect(lookup.resolve(undefined)).toBeNull();
    expect(fetchAirport).not.toHaveBeenCalled();
  });
});
