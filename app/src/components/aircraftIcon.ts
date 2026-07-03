import type { ComponentProps } from "react";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";

export type AircraftIconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

/**
 * Icon per ADS-B emitter category. Fixed-wing (A0–A6), gliders (B1) and unknown categories use the
 * default airplane; everything with a distinct shape gets its own icon. Shared by the AR labels and
 * the web map/radar/list.
 */
const CATEGORY_ICON: Partial<Record<string, AircraftIconName>> = {
  A7: "helicopter", // rotorcraft
  B2: "airballoon", // lighter-than-air (balloon / airship)
  B3: "parachute", // parachutist / skydiver
  B4: "paragliding", // ultralight / hang-glider / paraglider
  B6: "quadcopter", // UAV / drone
  B7: "rocket-launch", // space / trans-atmospheric
  C1: "car-emergency", // surface emergency vehicle
  C2: "truck", // surface service vehicle
  C3: "radio-tower", // point obstacle (e.g. tethered balloon)
  C4: "transmission-tower", // cluster obstacle
  C5: "transmission-tower", // line obstacle
};

export function iconForCategory(cat: string | null | undefined): AircraftIconName {
  return (cat ? CATEGORY_ICON[cat] : undefined) ?? "airplane";
}
