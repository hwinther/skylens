/**
 * The cockpit view's layer filter: which kinds of thing the 3D scene draws (other aircraft, other
 * vessels, airports, ports, ferry quays). Pure TS (no React) so jest runs it; the chips follow the List
 * tab's filter pattern (src/state/listFilter.ts) and the choice persists in settingsStore as a small
 * array of hidden ids, sanitised on load with listFilter's sanitizeIds.
 */

import { color } from "@/theme";
import { showsAirportOverlay, showsPortOverlay } from "./overlay";
import type { SimKind } from "./simPose";

/** Filter chips, in bar order. */
export const SIM_LAYERS = ["aircraft", "vessels", "airports", "ports", "ferries"] as const;
export type SimLayer = (typeof SIM_LAYERS)[number];

export const SIM_LAYER_LABEL: Record<SimLayer, string> = {
  aircraft: "Aircraft",
  vessels: "Vessels",
  airports: "Airports",
  ports: "Ports",
  ferries: "Ferry quays",
};

/** Chip colour: the colour the layer is drawn in. */
export const SIM_LAYER_COLOR: Record<SimLayer, string> = {
  aircraft: color.entity.air,
  vessels: color.entity.sea,
  airports: color.airport,
  ports: color.port,
  ferries: color.ferry,
};

export type SimLayerVisibility = Record<SimLayer, boolean>;

/**
 * The layers that exist when following this kind. From orbit there is no nearby traffic (the hub
 * subscription is not re-centred on a satellite) and the airport/port labels are off: no filter at all.
 */
export function simLayersFor(kind: SimKind): SimLayer[] {
  if (kind === "satellite") return [];
  return SIM_LAYERS.filter((l) => {
    if (l === "airports") return showsAirportOverlay(kind);
    if (l === "ports" || l === "ferries") return showsPortOverlay(kind);
    return true;
  });
}

/** Hidden ids (as stored) → which layers are drawn. */
export function simLayerVisibility(hidden: readonly string[]): SimLayerVisibility {
  return Object.fromEntries(SIM_LAYERS.map((l) => [l, !hidden.includes(l)])) as SimLayerVisibility;
}

export interface SimFilterChip {
  layer: SimLayer;
  label: string;
  color: string;
  /** The chip's pressed state: the layer is drawn. */
  shown: boolean;
}

export function simFilterChips(kind: SimKind, hidden: readonly string[]): SimFilterChip[] {
  return simLayersFor(kind).map((layer) => ({
    layer,
    label: SIM_LAYER_LABEL[layer],
    color: SIM_LAYER_COLOR[layer],
    shown: !hidden.includes(layer),
  }));
}

/** "2 hidden" for the collapsed filter button's label, or "" when everything is shown. */
export function hiddenSummary(chips: readonly SimFilterChip[]): string {
  const n = chips.filter((c) => !c.shown).length;
  return n ? `${n} hidden` : "";
}
