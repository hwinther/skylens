/**
 * Which generic 3D model (./models.ts) the followed object gets in the outside view. Pure TS, so jest
 * pins the table; resolved on the app side (the Android globe gets only the class key as a prop).
 *
 * Aircraft, from the bundled ICAO type table (src/aircraft/aircraftType.ts) when the designator is known:
 *  - helicopter / gyrocopter → helicopter; tiltrotor → turboprop (it cruises like one);
 *  - jet: heavy / super wake or four+ engines → widebody; one engine (fast military / single jets), light
 *    wake, or a medium-wake business jet (named like one: Gulfstream, Global, Challenger, Citation,
 *    Falcon, Learjet, Legacy, Phenom, Praetor, Hawker, …) → bizjet; otherwise → airliner;
 *  - turboprop: one engine → light single (PC-12, Caravan); light wake → small twin prop (Twin Otter,
 *    King Air, Do 228); otherwise → turboprop (Dash 8, ATR, Saab 340, C-130);
 *  - piston / electric / unpowered: one engine or none (gliders) → light single; three+ engines or medium
 *    wake → turboprop; otherwise → small twin prop (Islander, Seneca);
 *  - drone → light single; balloon / airship and parachutist → none (the marker stays).
 * Without a known type, the ADS-B emitter category: A1 light → light single, A2 small → turboprop (mostly
 * regional turboprops here), A3 large / A4 B757 → airliner, A5 heavy → widebody, A6 high performance →
 * bizjet, A7 rotorcraft → helicopter, B1 glider / B4 ultralight / B6 UAV → light single, B2 lighter than
 * air / B3 parachutist / B7 space / C* surface → none. No category at all → airliner.
 *
 * Vessels, by AIS ship type (ITU-R M.1371, the same tens-digit classes as src/components/vesselIcon.ts;
 * the DTO has no length): cargo 70–79 / tanker 80–89 → cargo ship; passenger 60–69 / high-speed craft
 * 40–49 → ferry; everything else (fishing, tugs, pilot / SAR, pleasure and sailing, unknown) → small boat.
 * An aid to navigation gets none. Satellites → satellite.
 */

import { lookupAircraftType, type AircraftTypeInfo } from "@/aircraft/aircraftType";
import type { SimKind } from "./simPose";
import type { SimModelClass } from "./models";

/** Medium-wake jets that are business jets, by the table's (manufacturer + model) name. */
const BIZJET_NAME =
  /gulfstream|\bglobal\b|challenger|citation|falcon|learjet|legacy|lineage|phenom|praetor|hawker|beechjet|premier|sabreliner|westwind|astra|jetstar|bd-?100|bd-?700|\bg-?\d{3}\b/i;

function forAircraftType(info: AircraftTypeInfo): SimModelClass | null | undefined {
  switch (info.cls) {
    case "helicopter":
    case "gyrocopter":
      return "helicopter";
    case "tiltrotor":
      return "turboprop";
    case "lighter-than-air":
    case "parachutist":
      return null;
    case "drone":
      return "light-single";
    case null:
      return undefined;
    default:
      break;
  }
  const engines = info.engines;
  const wake = info.wake;
  if (info.engineType === "jet") {
    if (wake === "heavy" || wake === "super" || (engines ?? 0) >= 4) return "widebody";
    if (engines === 1 || wake === "light") return "bizjet";
    if (info.name && BIZJET_NAME.test(info.name)) return "bizjet";
    return "airliner";
  }
  if (info.engineType === "turbine") {
    if (engines === 1) return "light-single";
    if (wake === "light") return "twin-prop";
    return "turboprop";
  }
  // Piston, electric, rocket, or no engine (gliders).
  if (engines == null || engines <= 1) return "light-single";
  if (engines >= 3 || wake === "medium" || wake === "heavy" || wake === "super") return "turboprop";
  return "twin-prop";
}

const BY_CATEGORY: Readonly<Record<string, SimModelClass | null>> = {
  A1: "light-single",
  A2: "turboprop",
  A3: "airliner",
  A4: "airliner",
  A5: "widebody",
  A6: "bizjet",
  A7: "helicopter",
  B1: "light-single",
  B2: null,
  B3: null,
  B4: "light-single",
  B6: "light-single",
  B7: null,
};

/** The model class for an aircraft from its type designator (`t`) and emitter category (`cat`). */
export function aircraftModelClass(ac: { t?: string | null; cat?: string | null }): SimModelClass | null {
  const info = lookupAircraftType(ac.t);
  if (info) {
    const byType = forAircraftType(info);
    if (byType !== undefined) return byType;
  }
  const cat = ac.cat?.trim().toUpperCase();
  if (cat) {
    if (cat in BY_CATEGORY) return BY_CATEGORY[cat];
    if (cat.startsWith("C")) return null; // surface vehicles and obstacles
  }
  return "airliner";
}

/** The model class for a vessel from its AIS ship type; none for an aid to navigation. */
export function vesselModelClass(v: { kind?: string | null; shipType?: number | null }): SimModelClass | null {
  if (v.kind === "aton") return null;
  const t = v.shipType ?? 0;
  if ((t >= 70 && t <= 79) || (t >= 80 && t <= 89)) return "cargo-ship";
  if ((t >= 60 && t <= 69) || (t >= 40 && t <= 49)) return "ferry";
  return "small-boat";
}

/** The model class for a followed object: the DTO decides for aircraft and vessels; satellites have one. */
export function simModelClass(
  kind: SimKind,
  dto: { t?: string | null; cat?: string | null; kind?: string | null; shipType?: number | null } | null | undefined,
): SimModelClass | null {
  if (kind === "satellite") return "satellite";
  if (kind === "aircraft") return aircraftModelClass(dto ?? {});
  return vesselModelClass(dto ?? {});
}
