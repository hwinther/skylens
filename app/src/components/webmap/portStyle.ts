/**
 * Shared visual language for the ports layer, so the web (Leaflet) and native (react-native-maps) maps
 * draw the same thing. Ports are fixed coastal infrastructure laid under the live traffic, so they use a
 * muted sea-green, dimmer than the live vessel teal — reference points, not targets. Pure (no RN
 * imports), so it is unit-testable.
 */

import type { PortDto, PortKind } from "@/api/types";
import { color } from "@/theme";

/** Port marker/glyph colour. */
export const PORT_COLOR = color.port;

/** MCI glyph per kind (tsc validates the names against the icon-font union at each usage). */
export const PORT_GLYPH = {
  port: "crane",
  harbour: "anchor",
  marina: "sail-boat",
  ferry: "ferry",
} as const satisfies Record<PortKind, string>;

const KIND_LABEL: Record<PortKind, string> = {
  port: "Port",
  harbour: "Harbour",
  marina: "Marina",
  ferry: "Ferry quay",
};

/** Marker glyph size: commercial ports a little larger than the many small quays and marinas. */
export function portGlyphSize(kind: PortKind): number {
  return kind === "port" ? 16 : 13;
}

/** Marker title: the name, or the kind for unnamed places. */
export function portTitle(p: PortDto): string {
  return p.name?.trim() || KIND_LABEL[p.kind];
}

/** Marker subtitle: the kind, plus the source (OSM vs World Port Index). */
export function portSubtitle(p: PortDto): string {
  const source = p.id.startsWith("wpi") ? "World Port Index" : "OpenStreetMap";
  return `${KIND_LABEL[p.kind]} · ${source}`;
}
