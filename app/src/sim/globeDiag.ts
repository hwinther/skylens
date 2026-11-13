/**
 * The cockpit globe's health counters and the policy that reads them, kept free of Cesium / React so
 * jest runs it. src/sim/simGlobe.ts fills a GlobeDiag from Cesium's events (tile requests, provider
 * errors, the WebGL context, a worker probe, a pixel probe); the Android DOM component forwards the
 * compact summary to the native screen, which logs it (logcat) and exposes it to Maestro.
 *
 * Why: on the first CI emulator run the globe reported its first frame but showed nothing but black,
 * and Cesium's own tile errors only reached the console. These counters say which stage broke:
 * network (tile requests failing), decoding (workers), or drawing (the canvas stays black).
 */

export interface TileCounts {
  /** Requests handed to the provider (not counting ones Cesium deferred because of throttling). */
  req: number;
  ok: number;
  fail: number;
}

export type WorkerProbe = "pending" | "ok" | "failed" | "timeout";

export interface GlobeDiag {
  /** "webgl2 <renderer>" / "webgl1 <renderer>", from WEBGL_debug_renderer_info when available. */
  gl: string;
  /** gl.MAX_TEXTURE_SIZE. */
  maxTex: number;
  /** Did a Cesium-style module worker start and answer from this page's origin? */
  workers: WorkerProbe;
  imagery: TileCounts;
  terrain: TileCounts;
  /** The base imagery layer could not be created at all (metadata request failed). */
  imageryLayerFailed: boolean;
  /** Globe tile load queue length (tileLoadProgressEvent). */
  queue: number;
  frames: number;
  /** Ms from globe creation to the first rendered frame (-1 until then). */
  firstFrameMs: number;
  /** Last pixel probe of the canvas, "r,g,b" bottom-centre (always ground) / "" before the first. */
  px: string;
  /** Consecutive probes, from the first, that read pure black; -1 once any probe saw colour. */
  blackProbes: number;
  /** Of those, the ones taken after the first imagery/terrain tile arrived (the scene had something to draw). */
  blackAfterTiles: number;
  /** Rendering was stopped: a software rasteriser drew nothing (shouldPauseRendering). */
  paused: boolean;
  /** Page errors seen (console.error, window.onerror, unhandledrejection, provider errors). */
  errors: number;
  /** The latest error, short. */
  lastError: string;
}

export function newGlobeDiag(): GlobeDiag {
  return {
    gl: "",
    maxTex: 0,
    workers: "pending",
    imagery: { req: 0, ok: 0, fail: 0 },
    terrain: { req: 0, ok: 0, fail: 0 },
    imageryLayerFailed: false,
    queue: 0,
    frames: 0,
    firstFrameMs: -1,
    px: "",
    blackProbes: 0,
    blackAfterTiles: 0,
    paused: false,
    errors: 0,
    lastError: "",
  };
}

const MAX_ERROR_CHARS = 160;

/** One error (an Error, Cesium's RequestErrorEvent, a DOM Event, anything) as a short line. */
export function describeError(e: unknown): string {
  let s: string;
  if (e == null) s = "unknown error";
  else if (typeof e === "string") s = e;
  else if (e instanceof Error) s = e.message || e.name;
  else if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.statusCode === "number") s = `HTTP ${o.statusCode}`;
    else if (typeof o.message === "string" && o.message) s = o.message;
    else if (typeof o.type === "string") s = `${o.type} event`;
    else s = Object.prototype.toString.call(e);
  } else s = String(e);
  s = s.replace(/\s+/g, " ").trim();
  return s.length > MAX_ERROR_CHARS ? `${s.slice(0, MAX_ERROR_CHARS - 1)}…` : s;
}

/** Record one error on the counters. */
export function noteError(d: GlobeDiag, where: string, e: unknown): void {
  d.errors += 1;
  d.lastError = `${where}: ${describeError(e)}`;
}

export type Rgb = readonly [number, number, number];

/**
 * Record one probe of the canvas: a few pixels read after the same frame (the first is the one shown as
 * `px`). It counts as black only when every sample is pure black: a scene that draws anything at all
 * (sky, ground, base colour) colours at least one of them.
 */
export function noteProbe(d: GlobeDiag, samples: readonly Rgb[]): void {
  if (samples.length === 0) return;
  d.px = samples[0].join(",");
  if (d.blackProbes < 0) return;
  const black = samples.every((c) => c[0] === 0 && c[1] === 0 && c[2] === 0);
  if (!black) {
    d.blackProbes = -1;
    return;
  }
  d.blackProbes += 1;
  if (tilesArrived(d)) d.blackAfterTiles += 1;
}

/** Record one single-pixel probe ("r,g,b"). */
export function notePixel(d: GlobeDiag, rgb: Rgb): void {
  noteProbe(d, [rgb]);
}

/** Has any imagery or terrain tile arrived (so the globe has something to draw)? */
export function tilesArrived(d: GlobeDiag): boolean {
  return d.imagery.ok > 0 || d.terrain.ok > 0;
}

/**
 * WebGL renderers that rasterise on the CPU (lower-case substrings of the `gl=` renderer string): the
 * Android emulator's and headless Chromium's SwiftShader, Mesa's llvmpipe/softpipe, Windows' WARP.
 */
export const SOFTWARE_RENDERERS: readonly string[] = [
  "swiftshader",
  "llvmpipe",
  "softpipe",
  "software",
  "microsoft basic render",
];

export function isSoftwareRenderer(gl: string): boolean {
  const s = gl.toLowerCase();
  return SOFTWARE_RENDERERS.some((r) => s.includes(r));
}

/** On a software renderer, once tiles have arrived, the canvas is probed this often (ms). */
export const SOFTWARE_PROBE_MS = 1_000;
/** All-black probes after the first tile arrived before a software renderer's rendering is stopped. */
export const SOFTWARE_BLANK_PROBES = 3;
/** Why the map is unavailable once rendering was stopped (shown under the HUD). */
export const PAUSED_REASON = "software graphics can't draw the 3D view";

/** Should the caller probe the canvas at the fast SOFTWARE_PROBE_MS rate now? */
export function fastProbing(d: GlobeDiag): boolean {
  return !d.paused && d.blackProbes >= 0 && isSoftwareRenderer(d.gl) && tilesArrived(d);
}

/**
 * Stop rendering? Only on a software rasteriser (on a real GPU black can be legitimate: night, space
 * behind a satellite, so this never fires there) whose canvas has stayed pure black at every sampled
 * pixel for SOFTWARE_BLANK_PROBES probes after tiles arrived, from the very first probe on. Rendering a
 * scene that draws nothing only burns the CPU; on the CI emulator it starved the UI thread and hung
 * the emulated GPU.
 */
export function shouldPauseRendering(d: GlobeDiag): boolean {
  return (
    !d.paused && d.blackProbes >= 0 && d.blackAfterTiles >= SOFTWARE_BLANK_PROBES && isSoftwareRenderer(d.gl)
  );
}

const tiles = (t: TileCounts) => `${t.req}/${t.ok}/${t.fail}`;

/**
 * The compact one-line summary (what logcat and the Maestro hierarchy get). Tile counts are
 * requested/ok/failed. Stable key order, no spaces around `=`, `|`-separated, so a grep can pick it apart.
 */
export function formatDiag(d: GlobeDiag): string {
  return [
    `gl=${d.gl || "?"}`,
    `tex=${d.maxTex}`,
    `wk=${d.workers}`,
    `img=${tiles(d.imagery)}${d.imageryLayerFailed ? "+layerfail" : ""}`,
    `ter=${tiles(d.terrain)}`,
    `q=${d.queue}`,
    `fr=${d.frames}`,
    `ff=${d.firstFrameMs}`,
    `px=${d.px || "-"}`,
    `blk=${d.blackProbes}`,
    `paused=${d.paused ? 1 : 0}`,
    `err=${d.errors}`,
    `last=${d.lastError || "-"}`,
  ].join("|");
}

/** Imagery tile failures with nothing loaded before we call the imagery failed. */
export const IMAGERY_FAIL_TILES = 8;
/** No imagery tile at all this long after the first frame: failed (slow or silently stuck). */
export const IMAGERY_NO_TILES_MS = 45_000;
/** Pixel probes (one every DIAG_PROBE_MS) that must all read pure black before we call the view blank. */
export const BLANK_PROBES = 4;
/** How often the canvas is probed and the summary may be reported. */
export const DIAG_PROBE_MS = 5_000;

export type ImageryVerdict = { state: "loaded" } | { state: "failed"; reason: string } | null;

/**
 * What to tell the user about the map, once (the caller reports the first non-null verdict):
 *  - failed: rendering was stopped (shouldPauseRendering), the imagery service could not be reached, tiles keep failing with none loaded, the canvas
 *    has drawn nothing but black (the device's graphics can't render the scene), or no tile has arrived
 *    IMAGERY_NO_TILES_MS after the first frame;
 *  - loaded: at least one imagery tile arrived, the load queue has drained, and a pixel probe has seen
 *    colour (so a canvas that stays black is never reported as loaded; the caller sets blackProbes to
 *    -1 when it cannot probe);
 *  - null: too early to say.
 * `drained` is the globe's own "queue empty and all tiles loaded".
 */
export function imageryVerdict(d: GlobeDiag, msSinceFirstFrame: number, drained: boolean): ImageryVerdict {
  if (d.paused) return { state: "failed", reason: PAUSED_REASON };
  if (d.imageryLayerFailed) return { state: "failed", reason: "map service unreachable" };
  if (d.blackProbes >= BLANK_PROBES) return { state: "failed", reason: "this device's graphics drew nothing" };
  if (d.imagery.ok === 0 && d.imagery.fail >= IMAGERY_FAIL_TILES)
    return { state: "failed", reason: "map tiles failed to load" };
  if (d.imagery.ok > 0 && drained && d.blackProbes < 0) return { state: "loaded" };
  if (d.imagery.ok === 0 && msSinceFirstFrame >= IMAGERY_NO_TILES_MS)
    return { state: "failed", reason: "no map tiles arrived" };
  return null;
}

/** Prefix of every diagnostic log line, native and webview side alike: grep logcat for it. */
export const DIAG_TAG = "SkylensSim";
