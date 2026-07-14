/**
 * Single source of truth for Skylens' visual tokens. Captures the existing dark tactical-HUD
 * palette verbatim — this file is a refactor target, not a redesign. Use `alpha(hex, a)` instead of
 * hand-writing rgba() so a colour has exactly one canonical form.
 */

/** #RRGGBB + 0..1 → "rgba(r, g, b, a)". The ONLY way to make a translucent brand colour. */
export function alpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export const color = {
  // Surfaces
  bg: "#0B1622",
  surface: "#0F1E2E",
  surface2: "#16283A", // hairline / row divider
  accentFill: "#12507A", // filled button / chip bg

  // Text
  text: "#EAF6FF",
  textDim: "#9FC7E0",
  textLabel: "#7FA6C4",
  textMuted: "#5C7A94",

  // Entity families (the semantic core — keep these names stable)
  entity: {
    air: "#78C8FF",
    sea: "#3FC9B0",
    orbit: "#C792EA", // was SAT_VIOLET, ×6 files
    sky: "#FFCF5C", // was PLANET_GOLD, ×3 files
  },

  // Vessel class palette (from vesselIcon.ts)
  vessel: {
    ship: "#3FC9B0", // generic / passenger  (=== entity.sea)
    cargo: "#4FB477",
    tanker: "#E0725C",
    highSpeed: "#48B7D8",
    fishing: "#5EC26A",
    special: "#E0A94E",
    sailing: "#7FD1E8",
  },

  // Aids to navigation
  aton: {
    physical: "#F2C14E",
    virtual: "#C77DBB",
  },

  // Fishing overlays (from fishingStyle.ts)
  fishing: {
    forbidden: "#E4483B",
    zero: "#F0A63C",
    cod: "#E85CC0",
    lostGear: "#FF8A3D",
  },

  // Status signal
  status: {
    ok: "#7CFC9A",
    warn: "#FFD37C",
    error: "#FF8A80",
  },

  // Airport reference (from airportStyle.ts — the canonical home for these consts)
  airport: "#7FA6C4", // AIRPORT_COLOR — steel-blue infrastructure (same hex as textLabel, kept distinct semantically)
  runway: "#9FB6CC", // RUNWAY_COLOR — a lighter steel above the airport marker's tone
} as const;

/** Course-vector (velocity-leader) colours — reference entity hues so they can't drift. */
export const course = {
  aircraft: color.entity.air,
  ship: color.entity.sea,
} as const;

export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const;
export const radius = { chip: 6, control: 10, card: 12, sheet: 16 } as const;
export const font = { micro: 10, label: 12, body: 14, control: 16, sheet: 20, title: 24 } as const;

/** Anchor-tick shape per family — consumed in PR-B. Colour still carries meaning; shape adds redundancy. */
export const entityShape = {
  air: "circle",
  sea: "square",
  orbit: "diamond",
  sky: "triangle",
} as const;
