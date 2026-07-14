/**
 * Pure airports-layer visual-language helpers: the small-airfield filter gating, the class glyph size,
 * and the title/subtitle/type-label text builders. No React or map engine — plain functions.
 */

import type { AirportDto } from "@/api/types";
import {
  AIRPORT_COLOR,
  AIRPORT_GLYPH,
  RUNWAY_COLOR,
  airportArPriority,
  airportFilter,
  airportGlyphSize,
  airportShortLabel,
  airportSubtitle,
  airportTitle,
  airportTypeLabel,
} from "@/components/webmap/airportStyle";

/** A minimal airport with sensible defaults; override the fields a case cares about. */
function airport(over: Partial<AirportDto> = {}): AirportDto {
  return {
    ident: "ENCN",
    iata: "KRS",
    name: "Kristiansand Airport",
    type: "medium_airport",
    lat: 58.2,
    lon: 8.08,
    elevationFt: 57,
    municipality: "Kristiansand",
    runways: [],
    frequencies: [],
    ...over,
  };
}

describe("airportFilter", () => {
  it("always shows large and medium airports, regardless of the small toggle", () => {
    expect(airportFilter("large_airport", false)).toBe(true);
    expect(airportFilter("medium_airport", false)).toBe(true);
  });

  it("gates small airfields / heliports / seaplane bases on showSmall", () => {
    for (const t of ["small_airport", "heliport", "seaplane_base"]) {
      expect(airportFilter(t, true)).toBe(true);
      expect(airportFilter(t, false)).toBe(false);
    }
  });
});

describe("airportGlyphSize", () => {
  it("scales by class (large > medium > small/heli/sea)", () => {
    expect(airportGlyphSize("large_airport")).toBe(22);
    expect(airportGlyphSize("medium_airport")).toBe(18);
    expect(airportGlyphSize("small_airport")).toBe(14);
    expect(airportGlyphSize("heliport")).toBe(14);
    expect(airportGlyphSize("seaplane_base")).toBe(14);
  });
});

describe("airportArPriority", () => {
  it("ranks large over medium over the smaller fields (higher wins the un-pushed AR slot)", () => {
    expect(airportArPriority("large_airport")).toBe(2);
    expect(airportArPriority("medium_airport")).toBe(1);
    expect(airportArPriority("small_airport")).toBe(0);
    expect(airportArPriority("heliport")).toBe(0);
    expect(airportArPriority("seaplane_base")).toBe(0);
    expect(airportArPriority("large_airport")).toBeGreaterThan(airportArPriority("medium_airport"));
    expect(airportArPriority("medium_airport")).toBeGreaterThan(airportArPriority("small_airport"));
  });
});

describe("airportTypeLabel", () => {
  it("humanizes known types and passes through unknown ones", () => {
    expect(airportTypeLabel("medium_airport")).toBe("Medium airport");
    expect(airportTypeLabel("heliport")).toBe("Heliport");
    expect(airportTypeLabel("seaplane_base")).toBe("Seaplane base");
    expect(airportTypeLabel("something_else")).toBe("something_else");
  });
});

describe("airportTitle", () => {
  it("uses the name when present", () => {
    expect(airportTitle(airport())).toBe("Kristiansand Airport");
  });

  it("falls back to the ident when the name is blank", () => {
    expect(airportTitle(airport({ name: "  " }))).toBe("ENCN");
  });
});

describe("airportShortLabel", () => {
  it("uses an ICAO/IATA-shaped ident as-is", () => {
    expect(airportShortLabel(airport({ ident: "ENGM" }))).toBe("ENGM");
    expect(airportShortLabel(airport({ ident: "KRS" }))).toBe("KRS");
  });

  it("falls back to the IATA code when the ident isn't a real code", () => {
    expect(airportShortLabel(airport({ ident: "NO-0085", iata: "XYZ" }))).toBe("XYZ");
  });

  it("falls back to the name's first word for a code-less community field", () => {
    expect(
      airportShortLabel(
        airport({ ident: "NO-0003", iata: null, name: "Kilen Seaplane Base" }),
      ),
    ).toBe("Kilen");
  });

  it("strips a trailing comma off the first word", () => {
    expect(
      airportShortLabel(airport({ ident: "NO-0004", iata: null, name: "Sørkjosen, Nord-Troms" })),
    ).toBe("Sørkjosen");
  });

  it("falls back to the bare ident when nothing else is usable", () => {
    expect(airportShortLabel(airport({ ident: "NO-0009", iata: null, name: "  " }))).toBe("NO-0009");
  });
});

describe("airportSubtitle", () => {
  it("joins ident, IATA and municipality", () => {
    expect(airportSubtitle(airport())).toBe("ENCN · KRS · Kristiansand");
  });

  it("omits absent IATA / municipality (ident always present)", () => {
    expect(airportSubtitle(airport({ iata: null, municipality: null }))).toBe("ENCN");
  });
});

describe("style constants", () => {
  it("airport is a dimmer steel-blue, runways lighter, glyph is the MCI airport name", () => {
    expect(AIRPORT_COLOR).toBe("#7FA6C4");
    expect(RUNWAY_COLOR).toBe("#9FB6CC");
    expect(AIRPORT_GLYPH).toBe("airport");
  });
});
