/**
 * Where the cockpit view's own controls go around an open detail card (pure, so jest runs it). The card
 * is the shared Sheet (components/sheetLayout.ts): a compact card at the bottom on narrow windows, a
 * side panel docked right on wide ones. The screen measures the card (SheetHeightContext) and moves its
 * bottom controls (web minimap, Android Recenter) above a compact card and its right-hand column left of
 * a side panel.
 */

import { SIDE_PANEL_WIDTH, sheetMode } from "@/components/sheetLayout";

/** Gap between the card and the controls lifted above it. */
export const CARD_GAP = 12;
/** The minimap only stays while the compact card takes at most this share of the window's height. */
export const MINIMAP_MAX_CARD_SHARE = 0.4;

export interface CockpitLayoutInput {
  windowWidth: number;
  windowHeight: number;
  cardOpen: boolean;
  /** The card's measured height (0 until measured). */
  cardHeight: number;
}

export interface CockpitLayout {
  /** Extra right offset for the right-hand controls (the side panel's width), px. */
  rightInset: number;
  /** Extra bottom offset for bottom controls (above a compact card), px. */
  bottomInset: number;
  /** False while an expanded compact card would leave the minimap no room. */
  minimapFits: boolean;
}

export function cockpitLayout({ windowWidth, windowHeight, cardOpen, cardHeight }: CockpitLayoutInput): CockpitLayout {
  if (!cardOpen) return { rightInset: 0, bottomInset: 0, minimapFits: true };
  if (sheetMode(windowWidth) === "panel") return { rightInset: SIDE_PANEL_WIDTH, bottomInset: 0, minimapFits: true };
  const h = Math.max(0, cardHeight);
  return {
    rightInset: 0,
    bottomInset: h > 0 ? h + CARD_GAP : 0,
    minimapFits: h <= windowHeight * MINIMAP_MAX_CARD_SHARE,
  };
}

/** Gap between the HUD box and the right-hand control column. */
export const HUD_COLUMN_GAP = 8;
/** Assumed width of the control column until it has been measured (about the "Outside view" chip). */
export const CONTROL_COLUMN_FALLBACK_WIDTH = 120;
/** The HUD never gets narrower than this (also its minWidth), even on a window too small for both. */
export const HUD_MIN_WIDTH = 180;

export interface HudWidthInput {
  windowWidth: number;
  /** The HUD's left offset from the window edge, px. */
  hudLeft: number;
  /** The control column's right offset from the window edge (safe area, margin, side panel), px. */
  columnRight: number;
  /** The column's measured width, px (0 until measured; the unfolded Layers panel counts). */
  columnWidth: number;
}

/**
 * The HUD box's max width so it stops short of the right-hand control column (Exit, Map, Outside view,
 * Details, Layers) instead of sliding under it: the HUD grows with its longest line (a status or
 * imagery note), which on a phone-sized window used to push its right-aligned values under the chips.
 * Long lines wrap instead.
 */
export function hudMaxWidth({ windowWidth, hudLeft, columnRight, columnWidth }: HudWidthInput): number {
  const column = columnWidth > 0 ? columnWidth : CONTROL_COLUMN_FALLBACK_WIDTH;
  return Math.max(HUD_MIN_WIDTH, Math.floor(windowWidth - hudLeft - columnRight - column - HUD_COLUMN_GAP));
}
