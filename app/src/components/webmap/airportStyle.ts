/**
 * Shared visual language for the airports layer, so the web (Leaflet), native (react-native-maps) and
 * radar surfaces draw the same thing. Airports are fixed infrastructure laid *under* the live traffic,
 * so they use a dimmer steel-blue than the aircraft blue (#78C8FF) — reference points, not targets.
 */

import type { AirportDto } from "@/api/types";
import { color } from "@/theme";

/** Airport marker/glyph colour — steel-blue, dimmer than the aircraft blue so it reads as infrastructure. */
export const AIRPORT_COLOR = color.airport;

/** Runway segment colour — a lighter steel so runways sit just above their airport marker's tone. */
export const RUNWAY_COLOR = color.runway;

/** MCI glyph for an airport marker (tsc validates the name against the icon-font union at each usage). */
export const AIRPORT_GLYPH = "airport" as const;

/** OurAirports classes that count as "small airfields" — gated by the showSmallAirfields toggle. */
const SMALL_TYPES = new Set(["small_airport", "heliport", "seaplane_base"]);

/**
 * Whether an airport of `type` should be shown. Large + medium airports always show while the airports
 * layer is on; the smaller fields (small_airport / heliport / seaplane_base) are gated by `showSmall`.
 */
export function airportFilter(type: string, showSmall: boolean): boolean {
  return SMALL_TYPES.has(type) ? showSmall : true;
}

/** Native marker glyph size by class: bigger for the busier airports so the map reads at a glance. */
export function airportGlyphSize(type: string): number {
  if (type === "large_airport") return 22;
  if (type === "medium_airport") return 18;
  return 14; // small_airport / heliport / seaplane_base
}

/**
 * AR-overlay declutter priority by class. The overlay's declutter places the highest-priority label
 * first (it keeps its un-pushed spot), so when several airports stack on the horizon the busier class
 * wins: large > medium > the smaller fields — mirroring the glyph-size hierarchy.
 */
export function airportArPriority(type: string): number {
  if (type === "large_airport") return 2;
  if (type === "medium_airport") return 1;
  return 0; // small_airport / heliport / seaplane_base
}

/** Friendly label for an OurAirports type code, e.g. "medium_airport" → "Medium airport". */
export function airportTypeLabel(type: string): string {
  switch (type) {
    case "large_airport":
      return "Large airport";
    case "medium_airport":
      return "Medium airport";
    case "small_airport":
      return "Small airport";
    case "heliport":
      return "Heliport";
    case "seaplane_base":
      return "Seaplane base";
    default:
      return type;
  }
}

/** Marker line 1 (title): the airport name, falling back to its ICAO/local ident. */
export function airportTitle(a: AirportDto): string {
  return a.name?.trim() || a.ident;
}

/**
 * Compact label for the AR / radar surfaces: prefer a real ICAO/IATA code, but community fields that
 * lack one carry a synthetic ident like "NO-0003" — useless as a label — so fall back to the IATA code,
 * then to the first word of the name ("Kilen Seaplane Base" → "Kilen"), and only to the raw ident as a
 * last resort. The detail sheet keeps the full name via `airportTitle`; this is the space-tight glyph text.
 */
export function airportShortLabel(a: AirportDto): string {
  if (/^[A-Z]{3,4}$/.test(a.ident)) return a.ident;
  const iata = a.iata?.trim();
  if (iata) return iata;
  const name = a.name?.trim();
  if (name) return name.split(/\s+/)[0].replace(/,$/, "");
  return a.ident;
}

/** Marker line 2 (subtitle): "ICAO · IATA · municipality" — whichever are present. */
export function airportSubtitle(a: AirportDto): string | undefined {
  const parts = [a.ident, a.iata?.trim() || null, a.municipality?.trim() || null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : airportTypeLabel(a.type);
}
