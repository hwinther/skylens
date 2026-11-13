/**
 * The cockpit globe's health counters (src/sim/globeDiag.ts): the one-line summary the Android
 * webview reports to logcat / Maestro, and the policy that turns the counters into the HUD's
 * "imagery loaded / unavailable (why)" note.
 */

import {
  BLANK_PROBES,
  describeError,
  formatDiag,
  IMAGERY_FAIL_TILES,
  IMAGERY_NO_TILES_MS,
  imageryVerdict,
  newGlobeDiag,
  noteError,
  notePixel,
} from "@/sim/globeDiag";

describe("describeError", () => {
  it("handles the shapes Cesium and the page throw", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError({ statusCode: 404, response: "x" })).toBe("HTTP 404");
    expect(describeError({ type: "error" })).toBe("error event");
    expect(describeError({ message: "Failed to obtain image tile" })).toBe("Failed to obtain image tile");
    expect(describeError(undefined)).toBe("unknown error");
    expect(describeError("multi\n  line")).toBe("multi line");
  });

  it("keeps it short", () => {
    const s = describeError("x".repeat(500));
    expect(s.length).toBe(160);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("formatDiag", () => {
  it("is one stable, grep-friendly line", () => {
    const d = newGlobeDiag();
    expect(formatDiag(d)).toBe(
      "gl=?|tex=0|wk=pending|img=0/0/0|ter=0/0/0|q=0|fr=0|ff=-1|px=-|blk=0|err=0|last=-",
    );
    d.gl = "webgl2 ANGLE (SwiftShader)";
    d.maxTex = 8192;
    d.workers = "ok";
    d.imagery = { req: 12, ok: 4, fail: 8 };
    d.imageryLayerFailed = true;
    notePixel(d, [0, 0, 0]);
    noteError(d, "imagery L8 138/76", { statusCode: 503 });
    expect(formatDiag(d)).toBe(
      "gl=webgl2 ANGLE (SwiftShader)|tex=8192|wk=ok|img=12/4/8+layerfail|ter=0/0/0|q=0|fr=0|ff=-1|px=0,0,0|blk=1" +
        "|err=1|last=imagery L8 138/76: HTTP 503",
    );
  });
});

describe("notePixel", () => {
  it("counts black probes from the start and stops counting once colour shows", () => {
    const d = newGlobeDiag();
    notePixel(d, [0, 0, 0]);
    notePixel(d, [0, 0, 0]);
    expect(d.blackProbes).toBe(2);
    notePixel(d, [20, 40, 90]);
    expect(d.blackProbes).toBe(-1);
    notePixel(d, [0, 0, 0]); // e.g. a dark frame later: the canvas has been proven to draw
    expect(d.blackProbes).toBe(-1);
    expect(d.px).toBe("0,0,0");
  });
});

describe("imageryVerdict", () => {
  const colour = () => {
    const d = newGlobeDiag();
    notePixel(d, [30, 60, 120]);
    return d;
  };

  it("waits while it is too early to tell", () => {
    expect(imageryVerdict(newGlobeDiag(), 0, false)).toBeNull();
    const d = colour();
    d.imagery = { req: 6, ok: 0, fail: 2 };
    expect(imageryVerdict(d, 10_000, false)).toBeNull();
  });

  it("loaded once a tile arrived, the queue drained and the canvas shows colour", () => {
    const d = colour();
    d.imagery = { req: 6, ok: 6, fail: 0 };
    expect(imageryVerdict(d, 5000, false)).toBeNull();
    expect(imageryVerdict(d, 5000, true)).toEqual({ state: "loaded" });
  });

  it("never says loaded while the canvas has only been black (or not probed yet)", () => {
    const d = newGlobeDiag();
    d.imagery = { req: 6, ok: 6, fail: 0 };
    expect(imageryVerdict(d, 5000, true)).toBeNull();
    for (let i = 0; i < BLANK_PROBES; i++) notePixel(d, [0, 0, 0]);
    expect(imageryVerdict(d, 20_000, true)).toEqual({
      state: "failed",
      reason: "this device's graphics drew nothing",
    });
  });

  it("failed when the service is unreachable", () => {
    const d = colour();
    d.imageryLayerFailed = true;
    expect(imageryVerdict(d, 0, false)).toEqual({ state: "failed", reason: "map service unreachable" });
  });

  it("failed when tiles keep failing and none loaded, but not over a few flaky tiles", () => {
    const d = colour();
    d.imagery = { req: 20, ok: 0, fail: IMAGERY_FAIL_TILES };
    expect(imageryVerdict(d, 1000, false)).toEqual({ state: "failed", reason: "map tiles failed to load" });
    d.imagery = { req: 20, ok: 3, fail: IMAGERY_FAIL_TILES };
    expect(imageryVerdict(d, 1000, false)).toBeNull();
  });

  it("failed when no tile has arrived long after the first frame", () => {
    const d = colour();
    expect(imageryVerdict(d, IMAGERY_NO_TILES_MS - 1, false)).toBeNull();
    expect(imageryVerdict(d, IMAGERY_NO_TILES_MS, false)).toEqual({
      state: "failed",
      reason: "no map tiles arrived",
    });
  });
});
