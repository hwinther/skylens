import {
  declutter,
  DEFAULT_DECLUTTER_CONFIG,
  LABEL_STEP_PX,
  type ScreenLabel,
} from "@/ar/declutter";

describe("declutter", () => {
  it("leaves non-overlapping labels in place", () => {
    const labels: ScreenLabel[] = [
      { id: "a", x: 50, y: 100, priority: 1 },
      { id: "b", x: 400, y: 100, priority: 1 }, // far in x → different column
      { id: "c", x: 50, y: 300, priority: 1 }, // far in y → no collision
    ];
    const { placed, clusters } = declutter(labels);
    expect(clusters).toHaveLength(0);
    expect(placed).toHaveLength(3);
    for (const p of placed) {
      const src = labels.find((l) => l.id === p.id) as ScreenLabel;
      expect(p.y).toBe(src.y);
    }
  });

  it("pushes a colliding label down by one step", () => {
    const labels: ScreenLabel[] = [
      { id: "hi", x: 100, y: 100, priority: 10 }, // wins the spot
      { id: "lo", x: 110, y: 105, priority: 1 }, // same column, overlaps → pushed
    ];
    const { placed } = declutter(labels);
    const hi = placed.find((p) => p.id === "hi")!;
    const lo = placed.find((p) => p.id === "lo")!;
    expect(hi.y).toBe(100);
    expect(lo.y).toBe(100 + LABEL_STEP_PX);
    expect(lo.anchorY).toBe(105); // keeps original anchor for the leader line
  });

  it("higher priority keeps the un-pushed spot regardless of input order", () => {
    const labels: ScreenLabel[] = [
      { id: "lo", x: 100, y: 100, priority: 1 },
      { id: "hi", x: 100, y: 102, priority: 5 },
    ];
    const { placed } = declutter(labels);
    const hi = placed.find((p) => p.id === "hi")!;
    expect(hi.y).toBe(102);
  });

  it("stacks several labels in fixed steps", () => {
    const labels: ScreenLabel[] = [
      { id: "a", x: 100, y: 100, priority: 5 },
      { id: "b", x: 100, y: 101, priority: 4 },
      { id: "c", x: 100, y: 102, priority: 3 },
    ];
    const { placed, clusters } = declutter(labels);
    expect(clusters).toHaveLength(0);
    const ys = placed.sort((p, q) => p.y - q.y).map((p) => p.y);
    expect(ys).toEqual([100, 100 + LABEL_STEP_PX, 100 + 2 * LABEL_STEP_PX]);
  });

  it("collapses an over-full column into a +N cluster chip", () => {
    // maxPushPx defaults to 6 steps → the 8th stacked label must cluster.
    const labels: ScreenLabel[] = Array.from({ length: 8 }, (_, i) => ({
      id: `ac${i}`,
      x: 200,
      y: 150 + i, // all in the same tight column
      priority: 100 - i,
    }));
    const { placed, clusters } = declutter(labels);
    expect(placed.length).toBeLessThan(8);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const totalClustered = clusters.reduce((s, c) => s + c.count, 0);
    expect(placed.length + totalClustered).toBe(8);
    // Chip carries the ids it collapsed.
    expect(clusters[0].ids.length).toBe(clusters[0].count);
  });

  it("cluster centroid is within the group's x/y bounds", () => {
    const labels: ScreenLabel[] = Array.from({ length: 10 }, (_, i) => ({
      id: `x${i}`,
      x: 300,
      y: 200 + i,
      priority: 100 - i,
    }));
    const { clusters } = declutter(labels);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    for (const c of clusters) {
      expect(c.x).toBeCloseTo(300, 6);
      expect(c.y).toBeGreaterThanOrEqual(200);
      expect(c.y).toBeLessThanOrEqual(210);
    }
  });

  it("is deterministic for equal priority (stable tie-break)", () => {
    const labels: ScreenLabel[] = [
      { id: "b", x: 100, y: 100, priority: 1 },
      { id: "a", x: 100, y: 100, priority: 1 },
    ];
    const first = declutter(labels);
    const second = declutter([...labels].reverse());
    expect(first.placed.map((p) => p.id).sort()).toEqual(["a", "b"]);
    expect(second.placed.map((p) => p.id).sort()).toEqual(["a", "b"]);
    // 'a' sorts before 'b' on the id tie-break → keeps the top slot both times.
    expect(first.placed.find((p) => p.id === "a")!.y).toBe(100);
  });

  it("terminates on the floating-point self-collision boundary (regression: AR tab freeze)", () => {
    // Real captured coordinate where (y + stepPx) - y rounds to *just under* stepPx
    // (27.9999… < 28). A pushed label then reads as still colliding with the label one step
    // above it, so y never advances and the greedy loop spins forever — a hard tab freeze once a
    // few ships stacked in one horizon-band column. The progress guard must break instead.
    const badY = 1000.4172261956943;
    expect(badY + LABEL_STEP_PX - badY).toBeLessThan(LABEL_STEP_PX); // precondition holds
    const labels: ScreenLabel[] = [
      { id: "a", x: 200, y: badY, priority: 2 },
      { id: "b", x: 200, y: badY, priority: 1 }, // same column + same y → collides, must not hang
    ];
    // If the loop regressed this would never return; Jest's per-test timeout would fail it.
    const { placed, clusters } = declutter(labels);
    expect(placed.length + clusters.reduce((s, c) => s + c.count, 0)).toBe(2);
  });

  it("uses the configured step size", () => {
    const cfg = { ...DEFAULT_DECLUTTER_CONFIG, stepPx: 40 };
    const labels: ScreenLabel[] = [
      { id: "a", x: 0, y: 0, priority: 2 },
      { id: "b", x: 0, y: 5, priority: 1 },
    ];
    const { placed } = declutter(labels, cfg);
    expect(placed.find((p) => p.id === "b")!.y).toBe(40);
  });
});
