/**
 * List tab filter + accordion: which kinds of object the List shows and which of its sections are
 * collapsed. Pure TS (no React, no react-native) so the rules are unit-tested on any OS.
 *
 * The filter is a List-only view on top of the layer toggles in Settings: a kind whose layer is off has
 * no chip and is never shown, and hiding a kind here changes nothing the AR view or the map draws.
 * Both choices persist in settingsStore as small arrays of ids; unknown ids are dropped on load (see
 * `sanitizeIds`), so a later build may add or rename kinds without breaking stored settings.
 */

import { color } from "@/theme";

/** Filter chips, in bar order. Traffic splits into Air and Sea, the split people care about. */
export const LIST_KINDS = ["air", "sea", "satellites", "sky", "radio", "events"] as const;
export type ListKind = (typeof LIST_KINDS)[number];

/** Collapsible sections, in list order. */
export const LIST_SECTIONS = ["traffic", "overhead", "sky", "radio", "events"] as const;
export type ListSection = (typeof LIST_SECTIONS)[number];

/** Which section each kind's rows live in. */
export const KIND_SECTION: Record<ListKind, ListSection> = {
  air: "traffic",
  sea: "traffic",
  satellites: "overhead",
  sky: "sky",
  radio: "radio",
  events: "events",
};

export const KIND_LABEL: Record<ListKind, string> = {
  air: "Air",
  sea: "Sea",
  satellites: "Satellites",
  sky: "Sky",
  radio: "Radio",
  events: "Events",
};

/** Chip colour: the entity family colour of the kind's rows (events share the gold sky family). */
export const KIND_COLOR: Record<ListKind, string> = {
  air: color.entity.air,
  sea: color.entity.sea,
  satellites: color.entity.orbit,
  sky: color.entity.sky,
  radio: color.entity.radio,
  events: color.entity.sky,
};

/** The Settings layer toggles that decide which kinds exist at all. */
export interface ListLayers {
  showShips: boolean;
  showAton: boolean;
  showSatellites: boolean;
  showPlanets: boolean;
  showRadioSky: boolean;
  showSkyEvents: boolean;
}

/** Kinds whose layer is on, in bar order. Aircraft have no layer toggle, so Air is always there. */
export function availableKinds(layers: ListLayers): ListKind[] {
  const on: Record<ListKind, boolean> = {
    air: true,
    sea: layers.showShips || layers.showAton,
    satellites: layers.showSatellites,
    sky: layers.showPlanets,
    radio: layers.showRadioSky,
    events: layers.showSkyEvents,
  };
  return LIST_KINDS.filter((k) => on[k]);
}

/**
 * Stored id list → the known ids it contains, de-duplicated, in canonical order. Anything that is not
 * an array (a missing key from older settings, a hand-edited value) reads as empty.
 */
export function sanitizeIds<T extends string>(value: unknown, known: readonly T[]): T[] {
  if (!Array.isArray(value)) return [];
  return known.filter((id) => value.includes(id));
}

/** Add the id when absent, remove it when present (canonical order, no duplicates). */
export function toggleId<T extends string>(list: readonly T[], id: T, known: readonly T[]): T[] {
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  return sanitizeIds(next, known);
}

export interface ListChip {
  kind: ListKind;
  label: string;
  color: string;
  count: number;
  /** True while the kind is shown (the chip's pressed state). */
  shown: boolean;
}

export interface ListSectionView {
  /** At least one of its kinds is available and not filtered out. */
  visible: boolean;
  expanded: boolean;
  /** Rows the section shows: the sum over its shown kinds. */
  count: number;
}

export interface ListView {
  chips: ListChip[];
  shown: Record<ListKind, boolean>;
  sections: Record<ListSection, ListSectionView>;
  /** Every available kind is filtered out: the List shows only the "Show all" empty state. */
  allFiltered: boolean;
}

/** What the List shows, given the layer toggles, the filter, the collapsed sections and row counts. */
export function listView(input: {
  layers: ListLayers;
  hidden: readonly string[];
  collapsed: readonly string[];
  counts: Record<ListKind, number>;
}): ListView {
  const { layers, hidden, collapsed, counts } = input;
  const available = availableKinds(layers);
  const shown = Object.fromEntries(
    LIST_KINDS.map((k) => [k, available.includes(k) && !hidden.includes(k)]),
  ) as Record<ListKind, boolean>;
  const chips = available.map((kind) => ({
    kind,
    label: KIND_LABEL[kind],
    color: KIND_COLOR[kind],
    count: counts[kind],
    shown: shown[kind],
  }));
  const sections = Object.fromEntries(
    LIST_SECTIONS.map((section) => {
      const kinds = LIST_KINDS.filter((k) => KIND_SECTION[k] === section && shown[k]);
      return [
        section,
        {
          visible: kinds.length > 0,
          expanded: !collapsed.includes(section),
          count: kinds.reduce((n, k) => n + counts[k], 0),
        },
      ];
    }),
  ) as Record<ListSection, ListSectionView>;
  return { chips, shown, sections, allFiltered: available.every((k) => !shown[k]) };
}

/**
 * Traffic heading breakdown for the shown families: "3 air · 2 sea", or just "3 air" / "2 sea" while
 * the other family is filtered out or its layer is off.
 */
export function trafficBreakdown(shown: Record<ListKind, boolean>, counts: Record<ListKind, number>): string {
  const parts: string[] = [];
  if (shown.air) parts.push(`${counts.air} air`);
  if (shown.sea) parts.push(`${counts.sea} sea`);
  return parts.join(" · ");
}
