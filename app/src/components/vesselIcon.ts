import type { ComponentProps } from "react";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { VesselDto } from "@/api/types";

export type VesselIconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

/** An icon glyph plus the colour that class of vessel is drawn in on the map/radar/list. */
export interface VesselIcon {
  name: VesselIconName;
  color: string;
}

/**
 * Vessel colours: a teal/green maritime family so ships read as clearly distinct from the blue
 * aircraft. Colour carries the ship class (MaterialCommunityIcons has only a handful of watercraft
 * glyphs, so several classes share the "ferry" glyph and are told apart by colour); AtoNs are a
 * single navigation amber.
 */
const SHIP = "#3FC9B0"; // generic / passenger
const CARGO = "#4FB477"; // dry cargo
const TANKER = "#E0725C"; // tanker (warm — hazardous cargo)
const HIGH_SPEED = "#48B7D8"; // high-speed craft
const FISHING = "#5EC26A"; // fishing
const SPECIAL = "#E0A94E"; // tug / towing / special craft
const SAILING = "#7FD1E8"; // sailing / pleasure craft
const ATON = "#F2C14E"; // physical aids to navigation (lights, beacons, buoys)
const VIRTUAL_ATON = "#C77DBB"; // virtual/phantom aid — muted magenta, echoing chart convention

/**
 * Icon + colour for a moving ship, keyed off the AIS `shipType` int (ITU-R M.1371). The mapping is
 * coarse — the ITU tens-digit classes collapsed onto the few watercraft glyphs MCI ships. Only
 * fishing/tug/sailing get a distinct glyph; passenger/cargo/tanker/HSC share "ferry" and separate
 * on colour. Unknown/absent types fall back to the generic ferry.
 */
function iconForShip(shipType: number | null | undefined): VesselIcon {
  const t = shipType ?? 0;
  if (t === 30) return { name: "fish", color: FISHING }; // fishing
  if (t === 31 || t === 32 || t === 52) return { name: "ship-wheel", color: SPECIAL }; // towing / tug
  if (t === 36 || t === 37) return { name: "sail-boat", color: SAILING }; // sailing / pleasure craft
  if (t >= 40 && t <= 49) return { name: "ferry", color: HIGH_SPEED }; // high-speed craft
  if (t >= 60 && t <= 69) return { name: "ferry", color: SHIP }; // passenger
  if (t >= 70 && t <= 79) return { name: "ferry", color: CARGO }; // cargo
  if (t >= 80 && t <= 89) return { name: "ferry", color: TANKER }; // tanker
  return { name: "ferry", color: SHIP };
}

/**
 * Icon for an Aid to Navigation, keyed off the AIS `aidType` int (ITU-R M.1371). Kept coarse:
 * fixed lights/lighthouses (1–8), fixed beacons (9–20), and everything else — floating buoys
 * (21–31) plus unknown/default — as a life-ring; all physical AtoNs share the navigation amber.
 *
 * A `virtual` AtoN has no physical structure on the water (a chart-only "phantom" mark broadcast by a
 * shore station), so it overrides the aidType entirely: a hollow outline marker in a muted magenta —
 * mirroring how paper/ENC charts render virtual marks in magenta — telling it apart from the solid
 * amber physical aids on every surface at a glance.
 */
function iconForAton(aidType: number | null | undefined, virtual: boolean | null | undefined): VesselIcon {
  if (virtual) return { name: "map-marker-radius-outline", color: VIRTUAL_ATON };
  const t = aidType ?? 0;
  if (t >= 1 && t <= 8) return { name: "lighthouse", color: ATON }; // lights / lighthouses
  if (t >= 9 && t <= 20) return { name: "lighthouse-on", color: ATON }; // fixed beacons
  return { name: "lifebuoy", color: ATON }; // floating buoys + default
}

/** Icon + colour for any vessel; dispatches on `kind` ("ship" | "aton"). Shared by map/radar/list. */
export function iconForVessel(v: VesselDto): VesselIcon {
  return v.kind === "aton" ? iconForAton(v.aidType, v.virtual) : iconForShip(v.shipType);
}
