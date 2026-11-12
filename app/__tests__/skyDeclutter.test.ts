import { declutter } from "@/ar/declutter";
import {
  AIRCRAFT_LABEL_BOX,
  declutterLayers,
  estimateLabelWidth,
  LABEL_ANCHOR_INSET_PX,
  LABEL_GAP_PX,
  ONE_LINE_LABEL_HEIGHT_PX,
  TWO_LINE_LABEL_HEIGHT_PX,
  type SizedLabel,
} from "@/ar/skyDeclutter";

/** A two-line sky chip (name + sub line) anchored at (x, y). */
function chip(id: string, x: number, y: number, priority: number, width = 70): SizedLabel {
  return { id, x, y, priority, width, height: TWO_LINE_LABEL_HEIGHT_PX };
}

/** Top/bottom edges of a placed chip, given the chips' translate(-6, -6). */
const top = (y: number) => y - LABEL_ANCHOR_INSET_PX;
const bottom = (y: number, h = TWO_LINE_LABEL_HEIGHT_PX) => top(y) + h;

describe("declutterLayers", () => {
  // The Android run: Jupiter (-2.1m) and Mars (0.7m) project ~60 device px (~23 dp) apart vertically
  // at the same x. The per-kind 28 px step left Mars's chip over Jupiter's magnitude line.
  const jupiter = chip("Jupiter", 120, 500, 2.1, 68);
  const mars = chip("Mars", 120, 523, -0.7, 55);

  it("reproduces the Jupiter/Mars overlap with the fixed-step declutter", () => {
    const { placed } = declutter([jupiter, mars]);
    const j = placed.find((p) => p.id === "Jupiter")!;
    const m = placed.find((p) => p.id === "Mars")!;
    expect(top(m.y)).toBeLessThan(bottom(j.y)); // the bug: the chips overlap
  });

  it("stacks Mars fully below Jupiter, keeping both anchors for the leader line", () => {
    const [res] = declutterLayers([[jupiter, mars]]);
    expect(res.clusters).toHaveLength(0);
    const j = res.placed.find((p) => p.id === "Jupiter")!;
    const m = res.placed.find((p) => p.id === "Mars")!;
    expect(j.y).toBe(500); // brighter body keeps its spot
    expect(j.anchorY).toBe(500);
    expect(top(m.y)).toBe(bottom(j.y) + LABEL_GAP_PX);
    expect(m.x).toBe(120); // stays in its object's column
    expect(m.anchorY).toBe(523); // leader line runs back to the true point
    // and it moved no further than needed (one chip height + gap)
    expect(m.y - m.anchorY).toBeLessThanOrEqual(TWO_LINE_LABEL_HEIGHT_PX + LABEL_GAP_PX);
  });

  it("leaves labels that do not touch where they are", () => {
    const [res] = declutterLayers([
      [chip("a", 100, 100, 1), chip("b", 100, 100 + TWO_LINE_LABEL_HEIGHT_PX + LABEL_GAP_PX, 0), chip("c", 300, 100, 0)],
    ]);
    for (const p of res.placed) expect(p.y).toBe(p.anchorY);
  });

  it("does not push a label whose box is horizontally clear, even at the same y", () => {
    const [res] = declutterLayers([[chip("left", 100, 200, 1, 70), chip("right", 175, 200, 0, 70)]]);
    expect(res.placed.find((p) => p.id === "right")!.y).toBe(200);
  });

  it("never moves a fixed obstacle (aircraft) and pushes the sky label below it", () => {
    const aircraft = { x: 110, y: 300, ...AIRCRAFT_LABEL_BOX };
    const [res] = declutterLayers([[chip("Mars", 120, 310, 0)]], [aircraft]);
    const m = res.placed[0];
    expect(top(m.y)).toBe(bottom(aircraft.y) + LABEL_GAP_PX);
  });

  it("declutters kinds against each other; an earlier layer is never pushed by a later one", () => {
    const planet = chip("Jupiter", 100, 400, 2);
    const sat = chip("25544", 105, 405, 5000); // much higher priority, but a later layer
    const [pRes, sRes] = declutterLayers([[planet], [sat]]);
    expect(pRes.placed[0].y).toBe(400);
    expect(top(sRes.placed[0].y)).toBe(bottom(400) + LABEL_GAP_PX);
  });

  it("stacks mixed heights on their own sizes", () => {
    const radio = { id: "SgrA", x: 100, y: 100, priority: 1, width: 60, height: ONE_LINE_LABEL_HEIGHT_PX };
    const [res] = declutterLayers([[radio, chip("b", 100, 101, 0)]]);
    const b = res.placed.find((p) => p.id === "b")!;
    expect(top(b.y)).toBe(bottom(100, ONE_LINE_LABEL_HEIGHT_PX) + LABEL_GAP_PX);
  });

  it("collapses an over-full column into a +N chip for that layer", () => {
    const many = Array.from({ length: 8 }, (_, i) => chip(`s${i}`, 100, 100 + i * 0.1, 10 - i));
    const [res] = declutterLayers([many]);
    expect(res.placed.length).toBeGreaterThan(1);
    expect(res.clusters).toHaveLength(1);
    expect(res.placed.length + res.clusters[0].count).toBe(8);
  });

  it("terminates with fractional and non-finite anchors", () => {
    const labels = Array.from({ length: 30 }, (_, i) => chip(`f${i}`, 100.37 + i * 0.013, 200.1 + i * 0.7, (i * 7) % 11));
    labels.push(chip("nan", 100, Number.NaN, 0));
    const [res] = declutterLayers([labels]);
    expect(res.placed.length + res.clusters.reduce((s, c) => s + c.count, 0)).toBe(31);
  });
});

describe("estimateLabelWidth", () => {
  it("uses the longest line plus chrome, capped at maxWidth", () => {
    expect(estimateLabelWidth(["Mars", null, "0.7m"], { charPx: 7, chromePx: 30, maxWidth: 150 })).toBe(58);
    expect(estimateLabelWidth(["GSAT0102 (GALILEO-FM3)"], { maxWidth: 170 })).toBe(170);
    expect(estimateLabelWidth([], { maxWidth: 150 })).toBe(30);
  });
});
