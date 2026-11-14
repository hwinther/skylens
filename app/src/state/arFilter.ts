/**
 * The AR view's layer filter: which groups of labels the AR overlay draws, so the view can be focused
 * on what one is looking for. Pure TS (no React, no react-native) so jest runs it.
 *
 * An AR-only view on top of the layer toggles in Settings, like the List filter (./listFilter): a group
 * whose Settings layers are all off has no chip and is never drawn, and hiding a group here changes
 * nothing the List, the Map or the cockpit view show, nor what is fetched or subscribed. The choice
 * persists in settingsStore as a small array of hidden ids, sanitised on load with sanitizeIds.
 *
 * The groups are what the overlay actually draws: aircraft (no Settings toggle, so always there), the
 * vessel surface band (ships + AtoN), satellites, the sky (planets / Sun / Moon, the ecliptic arc and
 * the radio sources) and airports. Ports, fishing layers and sky events are map / List layers, never
 * drawn in AR, so they have no chip here.
 */

import { color } from "@/theme";
import type { DetailKind } from "@/components/useDetailSelection";

/** Filter chips, in panel order. */
export const AR_GROUPS = ["aircraft", "vessels", "satellites", "sky", "airports"] as const;
export type ArGroup = (typeof AR_GROUPS)[number];

/** Chip labels: the cockpit filter's words for traffic and airports, the List's for the sky kinds. */
export const AR_GROUP_LABEL: Record<ArGroup, string> = {
  aircraft: "Aircraft",
  vessels: "Vessels",
  satellites: "Satellites",
  sky: "Sky",
  airports: "Airports",
};

/** Chip colour: the colour the group's labels are drawn in. */
export const AR_GROUP_COLOR: Record<ArGroup, string> = {
  aircraft: color.entity.air,
  vessels: color.entity.sea,
  satellites: color.entity.orbit,
  sky: color.entity.sky,
  airports: color.airport,
};

/** The Settings layer toggles that decide which groups exist in AR at all. */
export interface ArLayers {
  showShips: boolean;
  showAton: boolean;
  showSatellites: boolean;
  showPlanets: boolean;
  showEcliptic: boolean;
  showRadioSky: boolean;
  showAirports: boolean;
}

/** Groups with at least one Settings layer on, in panel order. Aircraft have no toggle: always there. */
export function availableArGroups(layers: ArLayers): ArGroup[] {
  const on: Record<ArGroup, boolean> = {
    aircraft: true,
    vessels: layers.showShips || layers.showAton,
    satellites: layers.showSatellites,
    sky: layers.showPlanets || layers.showEcliptic || layers.showRadioSky,
    airports: layers.showAirports,
  };
  return AR_GROUPS.filter((g) => on[g]);
}

export type ArGroupVisibility = Record<ArGroup, boolean>;

/** Which groups the overlay draws: available in Settings and not hidden here. */
export function arGroupVisibility(layers: ArLayers, hidden: readonly string[]): ArGroupVisibility {
  const available = availableArGroups(layers);
  return Object.fromEntries(
    AR_GROUPS.map((g) => [g, available.includes(g) && !hidden.includes(g)]),
  ) as ArGroupVisibility;
}

export interface ArFilterChip {
  group: ArGroup;
  label: string;
  color: string;
  /** The chip's pressed state: the group is drawn. */
  shown: boolean;
}

/** One chip per available group (a group off in Settings is left out, as in the List filter). */
export function arFilterChips(layers: ArLayers, hidden: readonly string[]): ArFilterChip[] {
  return availableArGroups(layers).map((group) => ({
    group,
    label: AR_GROUP_LABEL[group],
    color: AR_GROUP_COLOR[group],
    shown: !hidden.includes(group),
  }));
}

/** How many of the offered groups are hidden: the count on the filter button (0 = nothing hidden). */
export function hiddenArGroupCount(chips: readonly ArFilterChip[]): number {
  return chips.filter((c) => !c.shown).length;
}

/** The group a detail card's object is drawn in. */
export const DETAIL_GROUP: Record<DetailKind, ArGroup> = {
  aircraft: "aircraft",
  vessel: "vessels",
  satellite: "satellites",
  planet: "sky",
  radio: "sky",
  airport: "airports",
};

/**
 * True when the open card's object is no longer drawn (its group was hidden here): the AR screen then
 * closes the card, since a card for a label that is not on screen reads as a bug.
 */
export function detailHiddenByFilter(kind: DetailKind | null | undefined, visible: ArGroupVisibility): boolean {
  return kind != null && !visible[DETAIL_GROUP[kind]];
}
