/**
 * The cockpit view's Cesium scene, shared by the web screen (SimScreen.web.tsx) and the Android globe
 * (SimGlobeView.tsx, a DOM component in a webview). Imperative and React-free: given a loaded Cesium and
 * a container element it creates the widget (Esri World Imagery + terrain), drives the camera from the
 * caller's pose/look every frame, draws the "straight ahead" marker, and keeps the airport/port label
 * layers fresh. The caller owns the data (tracker, satellite propagation, device look) and the lifetime.
 * Browser only (DOM + WebGL); the pure math it calls lives in look.ts / overlay.ts.
 */

import type { Cartesian3, CesiumWidget, LabelCollection, PointPrimitiveCollection, Scene } from "cesium";
import {
  DIAG_PROBE_MS,
  formatDiag,
  imageryVerdict,
  newGlobeDiag,
  noteError,
  notePixel,
  type GlobeDiag,
  type TileCounts,
} from "./globeDiag";
import type { Cesium } from "./loadCesium";
import { forwardMarker, MAX_LOOK_PITCH_DEG, wrap180, type Look } from "./look";
import { distanceKm, type OverlayItem } from "./overlay";
import type { TrackedPose } from "./tracker";

export const ESRI_IMAGERY_URL = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
export const ESRI_TERRAIN_URL =
  "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";

/** How far ahead along the direction of travel the "straight ahead" marker is projected, metres. */
const FORWARD_PROBE_M = 20_000;
/** Drag sensitivity, degrees per pixel. */
const LOOK_DEG_PER_PX = 0.15;
/** How often each overlay layer checks whether it should refetch. */
const OVERLAY_TICK_MS = 2000;

/** Flight-path-vector style symbol: a ring with wings and a fin, like a HUD's velocity marker. */
const FPV_SVG =
  '<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="#7CFC9A" stroke-width="2" ' +
  'style="filter:drop-shadow(0 0 2px #000)"><circle cx="14" cy="14" r="5"/>' +
  '<path d="M2 14h7M19 14h7M14 9V3"/></svg>';

/** Edge arrow pointing towards straight ahead, `deg` clockwise from up. */
function arrowSvg(deg: number): string {
  return (
    `<svg width="28" height="28" viewBox="0 0 28 28" style="transform:rotate(${deg}deg);filter:drop-shadow(0 0 2px #000)">` +
    '<path d="M14 2 L24 22 L14 17 L4 22 Z" fill="#7CFC9A" stroke="#0B1622" stroke-width="1.5"/></svg>'
  );
}

/** One labelled-point layer (airports or ports): refetched once the object has moved `refetchKm`. */
export interface SimOverlayLayer {
  /** CSS colour of the points. */
  color: string;
  refetchKm: number;
  /** Fetch the items around a point (already rounded to 0.01°). Rejecting draws nothing; the next tick retries. */
  load: (lat: number, lon: number) => Promise<OverlayItem[]>;
  /** False → skip fetching for now (e.g. signed out behind real auth). */
  allowed: () => boolean;
}

export interface SimGlobeOptions {
  container: HTMLElement;
  /** The "straight ahead" marker element, positioned every frame (read lazily: it may mount later). */
  marker: () => HTMLElement | null;
  /** This frame's pose, given the terrain height under the previous one (undefined while unknown). */
  pose: (nowMs: number, terrainM: number | undefined) => TrackedPose | null;
  /** This frame's look offset; called right after `pose`, only when there is one. */
  look: () => Look;
  overlays: readonly SimOverlayLayer[];
  /** The first frame has been rendered: the globe is up (imagery may still be streaming in). */
  onFirstFrame?: () => void;
  /**
   * The base imagery, reported once (policy: imageryVerdict in ./globeDiag): "failed" with a short
   * reason when the service is unreachable, tiles keep failing, none arrive, or the canvas stays black;
   * "loaded" once tiles arrived, the queue drained and the canvas shows colour.
   */
  onImagery?: (state: "loaded" | "failed", reason?: string) => void;
  /** Cesium's render loop threw (it stops rendering), or the WebGL context was lost. */
  onRenderError?: (message: string) => void;
  /** Counters to fill (the caller may also record page errors on them); a fresh set otherwise. */
  diag?: GlobeDiag;
  /**
   * The diagnostic summary (formatDiag), throttled: every DIAG_PROBE_MS for the first minute, then
   * every 30 s; only when it changed.
   */
  onDiagnostic?: (summary: string) => void;
}

export interface SimGlobe {
  readonly scene: Scene;
  readonly diag: GlobeDiag;
  destroy: () => void;
}

/** After this many diagnostic ticks, report only every DIAG_SLOW_EVERY-th tick. */
const DIAG_FAST_TICKS = 12;
const DIAG_SLOW_EVERY = 6;
/** How long the worker probe may take before it counts as stuck. */
const WORKER_PROBE_MS = 15_000;

/**
 * Count a provider's tile requests: wrap `method` (requestImage / requestTileGeometry) so every promise
 * it hands Cesium also bumps `counts`. A resolved `undefined` counts as a failure (Cesium treats an
 * undefined image as one). Returns the undo.
 */
function countRequests(target: object, method: string, counts: TileCounts): () => void {
  const obj = target as Record<string, unknown>;
  const orig = obj[method];
  if (typeof orig !== "function") return () => undefined;
  obj[method] = function (this: unknown, ...args: unknown[]) {
    const p = (orig as (...a: unknown[]) => unknown).apply(this, args) as Promise<unknown> | undefined;
    if (p && typeof p.then === "function") {
      counts.req += 1;
      p.then(
        (v) => {
          if (v === undefined) counts.fail += 1;
          else counts.ok += 1;
        },
        () => {
          counts.fail += 1;
        },
      );
    }
    return p;
  };
  return () => {
    obj[method] = orig;
  };
}

/** The WebGL renderer string and texture limit, for the diagnostics. Never throws. */
function describeContext(scene: Scene, diag: GlobeDiag): void {
  try {
    const ctx = (scene as unknown as { context: { _gl: WebGLRenderingContext; webgl2: boolean } }).context;
    const gl = ctx._gl;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    diag.gl = `${ctx.webgl2 ? "webgl2" : "webgl1"} ${renderer}`.replace(/[|\s]+/g, " ").trim();
    diag.maxTex = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
  } catch (e) {
    noteError(diag, "gl info", e);
  }
}

/**
 * Start one of Cesium's module workers the way Cesium does (same URL, `type: "module"`) and wait for its
 * echo: tells whether tile decoding can work from this page's origin (file:// in the Android webview).
 */
function probeWorkers(C: Cesium, diag: GlobeDiag): () => void {
  let worker: Worker | undefined;
  const done = (state: GlobeDiag["workers"], err?: unknown) => {
    if (diag.workers !== "pending") return;
    diag.workers = state;
    if (err !== undefined) noteError(diag, "worker", err);
    worker?.terminate();
  };
  const timer = setTimeout(() => done("timeout"), WORKER_PROBE_MS);
  try {
    worker = new Worker(C.buildModuleUrl("Workers/transferTypedArrayTest.js"), { type: "module" });
    worker.onmessage = () => done("ok");
    worker.onerror = (e: ErrorEvent) => done("failed", e.message || "worker error event");
    const array = new Int8Array([1]);
    worker.postMessage({ array }, [array.buffer]);
  } catch (e) {
    done("failed", e);
  }
  return () => {
    clearTimeout(timer);
    worker?.terminate();
  };
}

/** Does this browser give us a WebGL context at all? Cesium needs one (WebGL 2 preferred). */
export function hasWebGL(doc: Document = document): boolean {
  try {
    const canvas = doc.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function createSimGlobe(C: Cesium, opts: SimGlobeOptions): SimGlobe {
  const cleanups: (() => void)[] = [];
  let destroyed = false;

  const diag = opts.diag ?? newGlobeDiag();
  const createdAt = Date.now();
  cleanups.push(probeWorkers(C, diag));

  const baseLayer = C.ImageryLayer.fromProviderAsync(C.ArcGisMapServerImageryProvider.fromUrl(ESRI_IMAGERY_URL));
  const terrain = new C.Terrain(C.ArcGISTiledElevationTerrainProvider.fromUrl(ESRI_TERRAIN_URL));
  const widget: CesiumWidget = new C.CesiumWidget(opts.container, {
    baseLayer,
    terrain,
    scene3DOnly: true,
  });
  const scene = widget.scene;
  scene.screenSpaceCameraController.enableInputs = false; // the camera is ours
  scene.globe.depthTestAgainstTerrain = true;
  describeContext(scene, diag);

  // --- readiness, tile health, diagnostics ---------------------------------------------------------
  // Tile errors go to the PROVIDER's errorEvent (the layer's errorEvent only covers creating the
  // provider); with no listener Cesium merely console.logs them. So listen to both, and count requests.
  let imageryReported = false;
  let firstFrameAt = 0;
  const evaluateImagery = () => {
    if (imageryReported || destroyed) return;
    const drained = diag.queue === 0 && scene.globe.tilesLoaded;
    const verdict = imageryVerdict(diag, firstFrameAt ? Date.now() - firstFrameAt : 0, drained);
    if (!verdict) return;
    imageryReported = true;
    if (verdict.state === "failed") opts.onImagery?.("failed", verdict.reason);
    else opts.onImagery?.("loaded");
  };
  interface TileError {
    message?: string;
    level?: number;
    x?: number;
    y?: number;
    error?: unknown;
  }
  type ErrorSource = { errorEvent?: { addEventListener: (f: (e: TileError) => void) => () => void } };
  const watchTileErrors = (provider: object, kind: string) => {
    const errorEvent = (provider as ErrorSource).errorEvent;
    if (!errorEvent) return;
    cleanups.push(
      errorEvent.addEventListener((err) => {
        const where = err.level === undefined ? kind : `${kind} L${err.level} ${err.x}/${err.y}`;
        noteError(diag, where, err.error ?? err.message);
      }),
    );
  };
  cleanups.push(
    baseLayer.errorEvent.addEventListener((err: unknown) => {
      diag.imageryLayerFailed = true;
      noteError(diag, "imagery layer", err);
      evaluateImagery();
    }),
  );
  cleanups.push(
    baseLayer.readyEvent.addEventListener((provider: object) => {
      if (destroyed) return;
      cleanups.push(countRequests(provider, "requestImage", diag.imagery));
      watchTileErrors(provider, "imagery");
    }),
  );
  cleanups.push(
    terrain.errorEvent.addEventListener((err: unknown) => {
      noteError(diag, "terrain provider", err);
    }),
  );
  cleanups.push(
    terrain.readyEvent.addEventListener((provider: object) => {
      if (destroyed) return;
      cleanups.push(countRequests(provider, "requestTileGeometry", diag.terrain));
      watchTileErrors(provider, "terrain");
    }),
  );
  cleanups.push(
    scene.globe.tileLoadProgressEvent.addEventListener((queued: number) => {
      diag.queue = queued;
      if (queued === 0) evaluateImagery();
    }),
  );
  cleanups.push(
    scene.renderError.addEventListener((_scene: Scene, err: unknown) => {
      noteError(diag, "render", err);
      opts.onRenderError?.(err instanceof Error ? err.message : String(err));
    }),
  );
  const canvas = scene.canvas;
  const onContextLost = () => {
    noteError(diag, "webgl", "context lost");
    opts.onRenderError?.("the WebGL context was lost");
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  cleanups.push(() => canvas.removeEventListener("webglcontextlost", onContextLost));

  // Pixel probe: one pixel near the bottom centre (ground or sea from every camera we use), read right
  // after a frame is drawn, once per DIAG_PROBE_MS. Pure black there means nothing reached the canvas.
  let probeDue = false;
  const probePixel = () => {
    try {
      const ctx = (scene as unknown as { context: { readPixels: (o: object) => Uint8Array } }).context;
      const px = ctx.readPixels({
        x: Math.floor(canvas.width / 2),
        y: Math.floor(canvas.height * 0.2), // GL rows count from the bottom
        width: 1,
        height: 1,
      });
      notePixel(diag, [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0]);
    } catch (e) {
      diag.blackProbes = -1; // can't tell: never hold "loaded" back on it
      noteError(diag, "pixel probe", e);
    }
  };
  cleanups.push(
    scene.postRender.addEventListener(() => {
      diag.frames += 1;
      if (probeDue) {
        probeDue = false;
        probePixel();
      }
      if (firstFrameAt) return;
      firstFrameAt = Date.now();
      diag.firstFrameMs = firstFrameAt - createdAt;
      opts.onFirstFrame?.();
    }),
  );

  let diagTicks = 0;
  let lastSummary = "";
  const diagTimer = setInterval(() => {
    if (destroyed) return;
    probeDue = true;
    evaluateImagery();
    diagTicks += 1;
    if (diagTicks > DIAG_FAST_TICKS && diagTicks % DIAG_SLOW_EVERY !== 0) return;
    const summary = formatDiag(diag);
    if (summary === lastSummary) return;
    lastSummary = summary;
    opts.onDiagnostic?.(summary);
  }, DIAG_PROBE_MS);
  cleanups.push(() => clearInterval(diagTimer));

  // --- camera -------------------------------------------------------------------------------------
  // "Straight ahead" marker: project a point FORWARD_PROBE_M along the direction of travel and draw it
  // straight into the DOM every frame (no React state at 60 fps).
  const enu = new C.Matrix4();
  const probeLocal = new C.Cartesian3();
  const probe = new C.Cartesian3();
  const toProbe = new C.Cartesian3();
  let markerState = "";
  const placeForwardMarker = (pose: TrackedPose, look: Look) => {
    const marker = opts.marker();
    if (!marker) return;
    const cam = widget.camera;
    const origin: Cartesian3 = C.Cartesian3.fromDegrees(pose.lon, pose.lat, pose.altM);
    C.Transforms.eastNorthUpToFixedFrame(origin, undefined, enu);
    const h = C.Math.toRadians(pose.headingDeg);
    const p = C.Math.toRadians(pose.pitchDeg);
    probeLocal.x = Math.sin(h) * Math.cos(p) * FORWARD_PROBE_M;
    probeLocal.y = Math.cos(h) * Math.cos(p) * FORWARD_PROBE_M;
    probeLocal.z = Math.sin(p) * FORWARD_PROBE_M;
    C.Matrix4.multiplyByPoint(enu, probeLocal, probe);
    C.Cartesian3.normalize(C.Cartesian3.subtract(probe, cam.positionWC, toProbe), toProbe);
    // Only trust the projection in front of the camera; behind it, fall back to the look offset.
    const inFront = C.Cartesian3.dot(toProbe, cam.directionWC) > 0.05;
    const win = inFront ? C.SceneTransforms.worldToWindowCoordinates(scene, probe) : undefined;
    const m = forwardMarker(
      look,
      win ? { x: win.x, y: win.y } : null,
      scene.canvas.clientWidth,
      scene.canvas.clientHeight,
    );
    marker.style.transform = `translate(${m.x}px, ${m.y}px)`;
    const state = m.onScreen ? "on" : `off:${Math.round(m.angleDeg)}`;
    if (state !== markerState) {
      markerState = state;
      marker.dataset.onscreen = String(m.onScreen);
      marker.innerHTML = m.onScreen ? FPV_SVG : arrowSvg(m.angleDeg);
    }
  };

  let lastPose: TrackedPose | null = null;
  const onPreRender = () => {
    const now = Date.now();
    const prev = lastPose;
    const terrain = prev ? scene.globe.getHeight(C.Cartographic.fromDegrees(prev.lon, prev.lat)) : undefined;
    const pose = opts.pose(now, terrain);
    if (!pose) return;
    lastPose = pose;
    const look = opts.look();
    widget.camera.setView({
      destination: C.Cartesian3.fromDegrees(pose.lon, pose.lat, pose.altM),
      orientation: {
        heading: C.Math.toRadians(pose.headingDeg + look.yaw),
        pitch: C.Math.toRadians(Math.max(-89, Math.min(89, pose.pitchDeg + look.pitch))),
        roll: 0,
      },
    });
    placeForwardMarker(pose, look);
  };
  cleanups.push(scene.preRender.addEventListener(onPreRender));

  // --- airports + ports: labelled points, each class visible from its own distance -----------------
  for (const layer of opts.overlays) {
    const labels: LabelCollection = scene.primitives.add(new C.LabelCollection());
    const points: PointPrimitiveCollection = scene.primitives.add(new C.PointPrimitiveCollection());
    const pointColor = C.Color.fromCssColorString(layer.color);
    const draw = (items: OverlayItem[]) => {
      labels.removeAll();
      points.removeAll();
      for (const it of items) {
        const position = C.Cartesian3.fromDegrees(it.lon, it.lat, it.altM);
        const shown = new C.DistanceDisplayCondition(0, it.rangeM);
        points.add({
          position,
          pixelSize: it.pixelSize,
          color: pointColor,
          outlineColor: C.Color.BLACK,
          outlineWidth: 1,
          distanceDisplayCondition: shown,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
        if (!it.label) continue;
        labels.add({
          position,
          text: it.label,
          font: "600 13px sans-serif",
          fillColor: C.Color.WHITE,
          outlineColor: C.Color.BLACK,
          outlineWidth: 3,
          style: C.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new C.Cartesian2(0, -14),
          distanceDisplayCondition: shown,
          // Like synthetic vision: labels stay readable even behind a ridge.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      }
    };
    let fetchedAt: { lat: number; lon: number } | null = null;
    let inFlight = false;
    const maybeFetch = () => {
      const pose = lastPose;
      if (!pose || inFlight || destroyed || !layer.allowed()) return;
      if (fetchedAt && distanceKm(fetchedAt.lat, fetchedAt.lon, pose.lat, pose.lon) < layer.refetchKm) return;
      inFlight = true;
      const at = { lat: pose.lat, lon: pose.lon };
      layer
        .load(Math.round(at.lat * 100) / 100, Math.round(at.lon * 100) / 100)
        .then((items) => {
          if (destroyed || labels.isDestroyed()) return;
          fetchedAt = at;
          draw(items);
        })
        .catch(() => {
          // Fail soft: nothing drawn this time; the next tick retries.
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const timer = setInterval(maybeFetch, OVERLAY_TICK_MS);
    cleanups.push(() => clearInterval(timer));
  }

  return {
    scene,
    diag,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      for (const fn of cleanups) fn();
      if (!widget.isDestroyed()) widget.destroy();
    },
  };
}

export interface LookGestureHandlers {
  get: () => Look;
  set: (look: Look) => void;
  /** False → dragging does nothing (e.g. the phone's own pan/tilt is aiming the view). */
  enabled: () => boolean;
  /** Double click / double tap: back to straight ahead. */
  onReset: () => void;
}

/** Drag to look around on `el` (pointer events, so mouse and touch alike). Returns the cleanup. */
export function attachLookGestures(el: HTMLElement, h: LookGestureHandlers): () => void {
  let drag: { x: number; y: number } | null = null;
  const onDown = (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY };
    el.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag || !h.enabled()) return;
    // A new object every time: mutating in place would also change the shared "level" constant, so
    // "Recenter" would snap back to the dragged offset.
    const look = h.get();
    h.set({
      yaw: wrap180(look.yaw - (e.clientX - drag.x) * LOOK_DEG_PER_PX),
      pitch: Math.max(
        -MAX_LOOK_PITCH_DEG,
        Math.min(MAX_LOOK_PITCH_DEG, look.pitch + (e.clientY - drag.y) * LOOK_DEG_PER_PX),
      ),
    });
    drag = { x: e.clientX, y: e.clientY };
  };
  const onUp = () => {
    drag = null;
  };
  const onReset = () => h.onReset();
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("dblclick", onReset);
  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    el.removeEventListener("dblclick", onReset);
  };
}
