/**
 * Shared visual language for the fishing-mode overlays, so the web (Leaflet) and native
 * (react-native-maps) maps draw the same thing. Regulation zones are context laid *under* the traffic,
 * so fills are translucent (~0.15) with a solid-ish border; the sea and vessels stay visible through them.
 *
 * Palette is chosen to sit apart from the existing surfaces (aircraft blue, vessel teal/green, satellite
 * violet): forbidden = prohibition red, zero = warm amber, cod = magenta line.
 */

import type { FishingZone, LostGear } from "@/api/types";

export type ZoneKind = "cod" | "forbidden" | "zero";

export interface ZoneStyle {
  /** Solid border / line colour. */
  stroke: string;
  /** Translucent polygon fill (unused for the cod LineString). */
  fill: string;
  /** Fill opacity for Leaflet (RN bakes the alpha into `fill`). */
  fillOpacity: number;
}

/**
 * One entry per `kind`. `fill` carries an explicit rgba (react-native-maps has no separate fill-opacity
 * prop, so the alpha lives in the colour); Leaflet also gets `fillOpacity` for its solid `fillColor`.
 */
export const ZONE_STYLES: Record<ZoneKind, ZoneStyle> = {
  // No-fishing / forbidden areas — prohibition red.
  forbidden: { stroke: "#E4483B", fill: "rgba(228, 72, 59, 0.15)", fillOpacity: 0.15 },
  // Coastal "zero" / special-restriction areas — warm amber, distinct from the red.
  zero: { stroke: "#F0A63C", fill: "rgba(240, 166, 60, 0.15)", fillOpacity: 0.15 },
  // Cod spawning-ground boundary lines — magenta (no fill; it's a LineString).
  cod: { stroke: "#E85CC0", fill: "rgba(232, 92, 192, 0.15)", fillOpacity: 0.15 },
};

/** Fall back to the forbidden style for any unexpected/absent kind so a zone is never invisible. */
export function zoneStyle(kind: string | null | undefined): ZoneStyle {
  return ZONE_STYLES[(kind as ZoneKind) in ZONE_STYLES ? (kind as ZoneKind) : "forbidden"];
}

/** Lost/ghost fishing gear — a snag hazard. A warning "hook" glyph in hazard orange (MCI-verified). */
export const LOST_GEAR_GLYPH = "hook" as const;
export const LOST_GEAR_COLOR = "#FF8A3D";

/** Marker line 1 (title): gear type + count, e.g. "Lost gear · GILLNET ×3". */
export function lostGearTitle(g: LostGear): string {
  const type = g.toolTypeCode?.trim() || "Gear";
  const count = g.count != null && g.count > 1 ? ` ×${g.count}` : "";
  return `Lost gear · ${type}${count}`;
}

/** Marker line 2 (description): lost date + cause, whichever are present. */
export function lostGearDescription(g: LostGear): string | undefined {
  const parts: string[] = [];
  const date = formatLostDate(g.lostTime);
  if (date) parts.push(date);
  if (g.lostCause?.trim()) parts.push(g.lostCause.trim());
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** ISO instant → YYYY-MM-DD (just the day; the time-of-day gear was lost is noise). Invalid → null. */
function formatLostDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** A zone's popup/callout text, or null when the upstream feed carried no `info` for it. */
export function zoneInfo(z: FishingZone): string | null {
  return z.info?.trim() || null;
}
