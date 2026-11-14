/**
 * The collapsed card's summary for the object the cockpit view FOLLOWS (pure, jest-tested). The HUD
 * right above already shows its altitude, speed and heading, and a distance from the user means little
 * while riding along, so this card says what the object is instead: one or two short lines, built only
 * from fields the detail sheets already have, each line's missing parts left out (SheetSummary joins
 * the rest with " · " and drops an empty line).
 *
 * Every other card (AR, List, Map, and other traffic tapped in the cockpit) keeps the live summary.
 */

import type { AircraftMetadata, RouteResponse, VesselMetadata } from "@/api/types";
import { aircraftTypeLabel } from "@/aircraft/aircraftType";
import { ORBIT_CLASS_NAMES, formatOrbitPeriod, type OrbitInfo } from "@/ar/orbitClass";

/** Parts of one summary line; falsy parts are left out. */
export type SummaryParts = (string | null | undefined | false)[];

const text = (s: string | null | undefined) => s?.trim() || null;
/** "ESSA → ENGM", "From ESSA", "To ENGM", or null without either end. */
export function routeText(route: Pick<RouteResponse, "originIcao" | "destinationIcao"> | null | undefined): string | null {
  const from = text(route?.originIcao);
  const to = text(route?.destinationIcao);
  if (from && to) return `${from} → ${to}`;
  if (from) return `From ${from}`;
  if (to) return `To ${to}`;
  return null;
}

export interface AircraftIdentityInput {
  metadata?: Pick<AircraftMetadata, "typeName" | "typeCode" | "registration" | "operator"> | null;
  route?: Pick<RouteResponse, "originIcao" | "destinationIcao"> | null;
  /** The ICAO address, shown only when nothing else identifies the aircraft and the title is its callsign. */
  hex?: string | null;
  /** The title shows a callsign (not the hex). */
  hasCallsign?: boolean;
  military?: boolean;
  signalLost?: boolean;
}

/**
 * e.g. ["Boeing 737-800 · LN-RRL · SAS", "ENGM → ESSA"]; without metadata (signed out, unknown
 * airframe) just the ICAO address, e.g. ["ICAO 4CA123"].
 */
export function aircraftIdentityLines(i: AircraftIdentityInput): SummaryParts[] {
  // Readable and short ("Boeing 737-800", "Airbus EC-135/635"): the airframe's own name, else the type table's.
  const type = aircraftTypeLabel(i.metadata ?? {}, { short: true });
  const reg = text(i.metadata?.registration);
  const operator = text(i.metadata?.operator);
  const identified = !!(type || reg || operator);
  const hex = text(i.hex);
  return [
    [
      i.signalLost && "Signal lost",
      type,
      reg,
      operator,
      !identified && i.hasCallsign && hex ? `ICAO ${hex.toUpperCase()}` : null,
      i.military && "Military",
    ],
    [routeText(i.route)],
  ];
}

export interface VesselIdentityInput {
  metadata?: Pick<VesselMetadata, "shipTypeText" | "registerType" | "callSign" | "destination"> | null;
  /** AtoN: its aid type and whether it is virtual, as on the live summary (but no distance). */
  aton?: { aidType: string | null; virtual: boolean } | null;
  /** The nav status text, the fallback when nothing else is known ("Moored", "At anchor"). */
  navStatus?: string | null;
  signalLost?: boolean;
}

/** e.g. ["Passenger ship · Call sign LHWR", "→ KIEL"]; name, flag and MMSI are in the card's header already. */
export function vesselIdentityLines(i: VesselIdentityInput): SummaryParts[] {
  if (i.aton) return [[i.aton.aidType, i.aton.virtual ? "Virtual aid" : null]];
  const type = text(i.metadata?.shipTypeText) ?? text(i.metadata?.registerType);
  const callSign = text(i.metadata?.callSign);
  const destination = text(i.metadata?.destination);
  return [
    [
      i.signalLost && "Signal lost",
      type,
      callSign ? `Call sign ${callSign}` : null,
      !type && !callSign && !destination ? text(i.navStatus) : null,
    ],
    [destination ? `→ ${destination}` : null],
  ];
}

/**
 * e.g. ["Low Earth orbit · 93 min period", "3 active transmitters"]; the HUD shows the class acronym and
 * the altitude, the header the name, group and NORAD id.
 */
export function satelliteIdentityLines(orbit: OrbitInfo | null, activeTransmitters: number | null): SummaryParts[] {
  return [
    [orbit ? ORBIT_CLASS_NAMES[orbit.class] : null, orbit ? `${formatOrbitPeriod(orbit.periodMin)} period` : null],
    [
      activeTransmitters
        ? `${activeTransmitters} active transmitter${activeTransmitters === 1 ? "" : "s"}`
        : null,
    ],
  ];
}
