/**
 * Detail-card layout policy (sheetLayout.ts) and the one-card-per-screen selection (useDetailSelection).
 */

import {
  COMPACT_MARGIN,
  COMPACT_MAX_WIDTH,
  DEFAULT_MAX_HEIGHT_PCT,
  SIDE_PANEL_BREAKPOINT,
  SIDE_PANEL_WIDTH,
  sheetLayout,
  sheetMode,
  sheetRightInset,
} from "@/components/sheetLayout";
import { nextSelection } from "@/components/useDetailSelection";

describe("sheetMode", () => {
  it("switches to the side panel at the breakpoint", () => {
    expect(sheetMode(390)).toBe("compact");
    expect(sheetMode(SIDE_PANEL_BREAKPOINT - 1)).toBe("compact");
    expect(sheetMode(SIDE_PANEL_BREAKPOINT)).toBe("panel");
    expect(sheetMode(1280)).toBe("panel");
  });
});

describe("sheetLayout", () => {
  it("phone, collapsed: summary + toggle, no body, no height cap", () => {
    const l = sheetLayout({ windowWidth: 390, expanded: false, maxHeightPct: 82 });
    expect(l).toEqual({
      mode: "compact",
      width: 390 - 2 * COMPACT_MARGIN,
      sideInset: COMPACT_MARGIN,
      showBody: false,
      showSummary: true,
      showToggle: true,
      maxHeightPct: null,
    });
  });

  it("phone, expanded: body instead of summary, capped at the sheet's own maxHeightPct", () => {
    const l = sheetLayout({ windowWidth: 390, expanded: true, maxHeightPct: 70 });
    expect(l.showBody).toBe(true);
    expect(l.showSummary).toBe(false);
    expect(l.showToggle).toBe(true);
    expect(l.maxHeightPct).toBe(70);
  });

  it("expanded without a sheet cap falls back to the default cap", () => {
    expect(sheetLayout({ windowWidth: 390, expanded: true }).maxHeightPct).toBe(DEFAULT_MAX_HEIGHT_PCT);
  });

  it("the compact card is capped in width and centred on wider sub-breakpoint windows", () => {
    const l = sheetLayout({ windowWidth: 800, expanded: false });
    expect(l.width).toBe(COMPACT_MAX_WIDTH);
    expect(l.sideInset).toBe((800 - COMPACT_MAX_WIDTH) / 2);
  });

  it("wide window: a fixed-width panel that always shows the full content", () => {
    for (const expanded of [false, true]) {
      const l = sheetLayout({ windowWidth: 1280, expanded, maxHeightPct: 82 });
      expect(l).toEqual({
        mode: "panel",
        width: SIDE_PANEL_WIDTH,
        sideInset: 0,
        showBody: true,
        showSummary: false,
        showToggle: false,
        maxHeightPct: null,
      });
    }
  });
});

describe("sheetRightInset", () => {
  it("is the panel width only while a card is open on a wide window", () => {
    expect(sheetRightInset(1280, true)).toBe(SIDE_PANEL_WIDTH);
    expect(sheetRightInset(1280, false)).toBe(0);
    expect(sheetRightInset(390, true)).toBe(0);
  });
});

describe("nextSelection", () => {
  it("selecting replaces whatever was selected, of any kind", () => {
    const a = nextSelection(null, "aircraft", "abc123");
    expect(a).toEqual({ kind: "aircraft", id: "abc123" });
    expect(nextSelection(a, "vessel", "257000000")).toEqual({ kind: "vessel", id: "257000000" });
    expect(nextSelection(a, "aircraft", "def456")).toEqual({ kind: "aircraft", id: "def456" });
  });

  it("clearing only clears its own kind", () => {
    const v = { kind: "vessel" as const, id: "257000000" };
    expect(nextSelection(v, "vessel", null)).toBeNull();
    expect(nextSelection(v, "aircraft", null)).toBe(v);
    expect(nextSelection(null, "aircraft", null)).toBeNull();
  });
});
