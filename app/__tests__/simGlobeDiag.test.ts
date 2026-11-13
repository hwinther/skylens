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
  fastProbing,
  isSoftwareRenderer,
  newGlobeDiag,
  noteError,
  notePixel,
  noteProbe,
  PAUSED_REASON,
  shouldPauseRendering,
  SOFTWARE_BLANK_PROBES,
  type GlobeDiag,
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
      "gl=?|tex=0|wk=pending|img=0/0/0|ter=0/0/0|q=0|fr=0|ff=-1|px=-|blk=0|paused=0|err=0|last=-",
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
        "|paused=0|err=1|last=imagery L8 138/76: HTTP 503",
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

describe("multi-pixel probes", () => {
  it("is black only when every sample is black, and shows the first sample", () => {
    const d = newGlobeDiag();
    noteProbe(d, [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(d.blackProbes).toBe(1);
    noteProbe(d, [
      [0, 0, 0],
      [0, 0, 0],
      [80, 120, 200], // the sky near the top: the scene draws
    ]);
    expect(d.blackProbes).toBe(-1);
    expect(d.px).toBe("0,0,0");
  });

  it("counts black probes after the first tile separately", () => {
    const d = newGlobeDiag();
    notePixel(d, [0, 0, 0]);
    expect(d.blackAfterTiles).toBe(0);
    d.terrain = { req: 1, ok: 1, fail: 0 };
    notePixel(d, [0, 0, 0]);
    expect(d).toMatchObject({ blackProbes: 2, blackAfterTiles: 1 });
  });
});

describe("stopping rendering on a software renderer that draws nothing", () => {
  const EMULATOR = "webgl2 Android Emulator OpenGL ES Translator (Google SwiftShader)";
  const black = (d: GlobeDiag, n: number) => {
    for (let i = 0; i < n; i++) notePixel(d, [0, 0, 0]);
  };
  const withTiles = (gl: string) => {
    const d = newGlobeDiag();
    d.gl = gl;
    d.imagery = { req: 10, ok: 8, fail: 0 };
    return d;
  };

  it("knows the software rasterisers, case-insensitively", () => {
    expect(isSoftwareRenderer(EMULATOR)).toBe(true);
    expect(isSoftwareRenderer("webgl2 ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)")).toBe(
      true,
    );
    expect(isSoftwareRenderer("webgl2 llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(true);
    expect(isSoftwareRenderer("webgl2 ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11)")).toBe(true);
    expect(isSoftwareRenderer("webgl2 Adreno (TM) 740")).toBe(false);
    expect(isSoftwareRenderer("webgl2 Android Emulator OpenGL ES Translator (NVIDIA GeForce RTX 3060)")).toBe(false);
    expect(isSoftwareRenderer("")).toBe(false);
  });

  it("pauses after SOFTWARE_BLANK_PROBES black probes once tiles arrived, and says so", () => {
    const d = withTiles(EMULATOR);
    expect(fastProbing(d)).toBe(true);
    black(d, SOFTWARE_BLANK_PROBES - 1);
    expect(shouldPauseRendering(d)).toBe(false);
    black(d, 1);
    expect(shouldPauseRendering(d)).toBe(true);

    d.paused = true;
    expect(shouldPauseRendering(d)).toBe(false); // once
    expect(fastProbing(d)).toBe(false);
    expect(imageryVerdict(d, 5000, true)).toEqual({ state: "failed", reason: PAUSED_REASON });
    expect(formatDiag(d)).toContain("|paused=1|");
  });

  it("never pauses a hardware renderer, however black (night side, space behind a satellite)", () => {
    const d = withTiles("webgl2 Mali-G710");
    black(d, 50);
    expect(fastProbing(d)).toBe(false);
    expect(shouldPauseRendering(d)).toBe(false);
  });

  it("does not count black frames before any tile arrived (nothing to draw yet)", () => {
    const d = newGlobeDiag();
    d.gl = EMULATOR;
    black(d, 10);
    expect(fastProbing(d)).toBe(false);
    expect(shouldPauseRendering(d)).toBe(false);
  });

  it("never pauses once the canvas has shown colour (headless Chromium draws the globe)", () => {
    const d = withTiles("webgl2 ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)");
    notePixel(d, [20, 40, 90]);
    black(d, 10);
    expect(fastProbing(d)).toBe(false);
    expect(shouldPauseRendering(d)).toBe(false);
  });
});
