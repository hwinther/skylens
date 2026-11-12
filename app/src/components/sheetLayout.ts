/**
 * Layout policy for the detail card (Sheet.tsx), kept pure so it is jest-testable without rendering.
 *
 * - Narrow windows (phones, and tablets in portrait): a compact card docked to the bottom of the screen
 *   above the tab bar. Collapsed it shows the header + a one-line summary; expanded it shows the full
 *   content, capped at `maxHeightPct` of the screen and scrolling inside.
 * - Wide windows (SIDE_PANEL_BREAKPOINT and up, any platform): a fixed-width side panel docked to the
 *   right, full height of the content area, always showing the full content (no collapsed state).
 */

/** Window width (dp / CSS px) from which the card becomes a right-docked side panel. */
export const SIDE_PANEL_BREAKPOINT = 900;
/** Width of the side panel. */
export const SIDE_PANEL_WIDTH = 360;
/** The compact card never grows wider than this; on wider (sub-breakpoint) windows it is centred. */
export const COMPACT_MAX_WIDTH = 560;
/** Gap between the compact card and the screen edges. */
export const COMPACT_MARGIN = 8;
/** Room a scrolling screen leaves under its content so the collapsed card doesn't hide the last rows. */
export const COLLAPSED_CARD_CLEARANCE = 140;
/** Expanded-height cap (percent of the screen) when a sheet does not pass its own. */
export const DEFAULT_MAX_HEIGHT_PCT = 82;

export type SheetMode = "compact" | "panel";

export interface SheetLayoutInput {
  windowWidth: number;
  /** User's expand toggle; ignored by the side panel. */
  expanded: boolean;
  /** The sheet's own expanded-height cap, if any. */
  maxHeightPct?: number;
}

export interface SheetLayout {
  mode: SheetMode;
  /** Card width. */
  width: number;
  /** Compact card only: left/right offset that centres it (>= COMPACT_MARGIN); 0 for the panel. */
  sideInset: number;
  /** Full content (body) shown. */
  showBody: boolean;
  /** One-line summary shown (only in the collapsed compact card). */
  showSummary: boolean;
  /** Expand / collapse control shown. */
  showToggle: boolean;
  /** Height cap in percent of the screen; null = no cap (collapsed card, or the full-height panel). */
  maxHeightPct: number | null;
}

export function sheetMode(windowWidth: number): SheetMode {
  return windowWidth >= SIDE_PANEL_BREAKPOINT ? "panel" : "compact";
}

export function sheetLayout({ windowWidth, expanded, maxHeightPct }: SheetLayoutInput): SheetLayout {
  if (sheetMode(windowWidth) === "panel") {
    return {
      mode: "panel",
      width: SIDE_PANEL_WIDTH,
      sideInset: 0,
      showBody: true,
      showSummary: false,
      showToggle: false,
      maxHeightPct: null,
    };
  }
  const width = Math.min(COMPACT_MAX_WIDTH, Math.max(0, windowWidth - 2 * COMPACT_MARGIN));
  return {
    mode: "compact",
    width,
    sideInset: Math.max(COMPACT_MARGIN, (windowWidth - width) / 2),
    showBody: expanded,
    showSummary: !expanded,
    showToggle: true,
    maxHeightPct: expanded ? (maxHeightPct ?? DEFAULT_MAX_HEIGHT_PCT) : null,
  };
}

/**
 * How much of the screen's right edge an open card covers: the panel width while a card is open on a
 * wide window, else 0 (the compact card sits at the bottom). Screens shift right-edge controls by it.
 */
export function sheetRightInset(windowWidth: number, open: boolean): number {
  return open && sheetMode(windowWidth) === "panel" ? SIDE_PANEL_WIDTH : 0;
}
