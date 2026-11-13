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
