/**
 * The cockpit view's Cesium scene, shared by the web screen (SimScreen.web.tsx) and the Android globe
 * (SimGlobeView.tsx, a DOM component in a webview). Imperative and React-free: given a loaded Cesium and
 * a container element it creates the widget (Esri World Imagery + terrain), drives the camera from the
 * caller's pose/look every frame, draws the "straight ahead" marker, and keeps the airport/port label
 * layers fresh. The caller owns the data (tracker, satellite propagation, device look) and the lifetime.
 *
 * On top of that, driven through the returned handle (plain JSON in, so Android can call it from props):
 *  - other traffic (setTraffic, ~1 Hz): points + short labels, dead-reckoned per frame with the AR
 *    view's PositionTracker; the primitives are created, updated and removed in place per id;
 *  - picking (pick): which traffic point/label is under a tap;
 *  - the layer filter (setVisibility): airports / ports / ferry quays shown or hidden in place;
 *  - the camera mode (setCameraMode): cockpit, or chase (behind and above, see chase.ts) with a point
 *    and heading chevron marking the followed object;
 *  - the route line (setDestination): a great circle from the object to a known destination.
 * Browser only (DOM + WebGL); the pure math it calls lives in look.ts / overlay.ts / chase.ts / route.ts.
 */

import type {
  Cartesian3,
  CesiumWidget,
  Label,
  LabelCollection,
  PointPrimitive,
  PointPrimitiveCollection,
  Polyline,
  PolylineCollection,
  Scene,
} from "cesium";
import { PositionTracker, type PositionSample, type TrackPoint } from "@/ar/positionTracker";
import { color } from "@/theme";
import { chaseCamera, chaseSpec, chevronEnu, chevronSizeM, type CameraMode } from "./chase";
import {
  DIAG_PROBE_MS,
  formatDiag,
  imageryVerdict,
  fastProbing,
  newGlobeDiag,
  noteError,
  noteProbe,
  PAUSED_REASON,
  shouldPauseRendering,
  SOFTWARE_PROBE_MS,
  type GlobeDiag,
  type Rgb,
  type TileCounts,
} from "./globeDiag";
import type { Cesium } from "./loadCesium";
import type { SimLayerVisibility } from "./layers";
import { DOUBLE_TAP_MS, forwardMarker, isTap, MAX_LOOK_PITCH_DEG, wrap180, type Look, type PointerMark } from "./look";
import { distanceKm, type OverlayGroup, type OverlayItem } from "./overlay";
import { greatCirclePoints, type GeoPos } from "./route";
import type { SimKind } from "./simPose";
import type { TrackedPose } from "./tracker";
import type { TrafficItem, TrafficKind, TrafficPick } from "./traffic";

export const ESRI_IMAGERY_URL = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
export const ESRI_TERRAIN_URL =
  "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";

/** How far ahead along the direction of travel the "straight ahead" marker is projected, metres. */
const FORWARD_PROBE_M = 20_000;
/** Drag sensitivity, degrees per pixel. */
const LOOK_DEG_PER_PX = 0.15;
/** How often each overlay layer checks whether it should refetch. */
const OVERLAY_TICK_MS = 2000;
/** How often the route line's start is moved to the object. */
const ROUTE_TICK_MS = 1000;
/** Tap tolerance for picking traffic: a square this many CSS px around the tap. */
const PICK_PX = 24;
/** While rendering is stopped, the camera / pose / forward marker still update this often (ms). */
const PAUSED_TICK_MS = 250;
/** The chase camera keeps at least this much clearance above the terrain under it. */
const CHASE_CLEARANCE_M = 10;

/** The followed object's colour (chase marker), by kind. */
const KIND_ACCENT: Record<SimKind, string> = {
  aircraft: color.entity.air,
  vessel: color.entity.sea,
  satellite: color.entity.orbit,
};

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

/** The id stamped on traffic primitives, so a pick can tell them from airport/port labels. */
interface TrafficPrimitiveId {
  simTraffic: true;
  kind: TrafficKind;
  id: string;
}

interface TrafficEntry {
  item: TrafficItem;
  point: PointPrimitive;
  label: Label | null;
}

export interface SimGlobeOptions {
  container: HTMLElement;
  /** What is followed now (read every frame: the chase distance and marker colour depend on it). */
  kind: () => SimKind;
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
  /** Other traffic to draw (src/sim/traffic.ts selectTraffic); replaces the previous set. */
  setTraffic: (items: readonly TrafficItem[]) => void;
  /** Show or hide the airport / port / ferry-quay labels (traffic is filtered by the caller). */
  setVisibility: (v: SimLayerVisibility) => void;
  setCameraMode: (mode: CameraMode) => void;
  /** Draw the route line to this destination, or none. */
  setDestination: (dest: GeoPos | null) => void;
  /** The traffic under canvas position (x, y) in CSS px, or null. */
  pick: (x: number, y: number) => TrafficPick | null;
  /** Forget the traffic tracks (the followed object changed). */
  clearTraffic: () => void;
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

  // Pixel probe: three pixels down the vertical centre line (near the bottom: ground or sea from every
  // camera we use; the middle; near the top: sky, or the Earth below a satellite), read right after a
  // frame is drawn, once per DIAG_PROBE_MS (every SOFTWARE_PROBE_MS on a software renderer once tiles
  // arrived, see below). All three pure black means nothing reached the canvas.
  let probeDue = false;
  const probePixel = () => {
    try {
      const ctx = (scene as unknown as { context: { readPixels: (o: object) => Uint8Array } }).context;
      const x = Math.floor(canvas.width / 2);
      const samples: Rgb[] = [0.2, 0.5, 0.8].map((f) => {
        // GL rows count from the bottom.
        const px = ctx.readPixels({ x, y: Math.floor(canvas.height * f), width: 1, height: 1 });
        return [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0];
      });
      noteProbe(diag, samples);
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
        // Deferred: stop the loop between frames, not from inside one.
        if (shouldPauseRendering(diag)) setTimeout(pauseRendering, 0);
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
  // A software rasteriser that has tiles but still draws only black gets probed faster, so rendering
  // stops a few seconds in (shouldPauseRendering) instead of grinding on for the 20 s blank verdict.
  const fastProbeTimer = setInterval(() => {
    if (!destroyed && fastProbing(diag)) probeDue = true;
  }, SOFTWARE_PROBE_MS);
  cleanups.push(() => clearInterval(fastProbeTimer));

  // --- other traffic: points + labels, updated in place, dead-reckoned per frame -------------------
  const trafficPoints: PointPrimitiveCollection = scene.primitives.add(new C.PointPrimitiveCollection());
  const trafficLabels: LabelCollection = scene.primitives.add(new C.LabelCollection());
  // The AR view's tracker (with its snap guard): smooth between ~1 Hz updates, no smear on a jump.
  const trafficTracks = new PositionTracker<PositionSample>();
  const traffic = new Map<string, TrafficEntry>();
  const trafficPt: TrackPoint = { lat: 0, lon: 0, alt: 0 };
  const trafficScratch = new C.Cartesian3();
  const keyOf = (it: { kind: string; id: string }) => `${it.kind}:${it.id}`;
  const addTrafficLabel = (it: TrafficItem, pickId: TrafficPrimitiveId, position: Cartesian3): Label =>
    trafficLabels.add({
      position,
      text: it.label,
      font: "600 12px sans-serif",
      fillColor: C.Color.fromCssColorString(it.color),
      outlineColor: C.Color.BLACK,
      outlineWidth: 3,
      style: C.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new C.Cartesian2(0, -12),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      id: pickId,
    });
  const setTraffic = (items: readonly TrafficItem[]) => {
    if (destroyed) return;
    trafficTracks.sync(items, keyOf, (it): PositionSample => it, Date.now());
    const seen = new Set<string>();
    for (const it of items) {
      const key = keyOf(it);
      seen.add(key);
      const position = C.Cartesian3.fromDegrees(it.lon, it.lat, it.altM);
      const pickId: TrafficPrimitiveId = { simTraffic: true, kind: it.kind, id: it.id };
      const entry = traffic.get(key);
      if (!entry) {
        const point = trafficPoints.add({
          position,
          pixelSize: it.kind === "aircraft" ? 8 : 7,
          color: C.Color.fromCssColorString(it.color),
          outlineColor: C.Color.BLACK,
          outlineWidth: 1.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          id: pickId,
        });
        traffic.set(key, { item: it, point, label: it.label ? addTrafficLabel(it, pickId, position) : null });
        continue;
      }
      if (it.color !== entry.item.color) {
        const c = C.Color.fromCssColorString(it.color);
        entry.point.color = c;
        if (entry.label) entry.label.fillColor = c;
      }
      if (!it.label && entry.label) {
        trafficLabels.remove(entry.label);
        entry.label = null;
      } else if (it.label && !entry.label) {
        entry.label = addTrafficLabel(it, pickId, position);
      } else if (entry.label && it.label !== entry.item.label) {
        entry.label.text = it.label;
      }
      entry.item = it;
    }
    for (const [key, entry] of traffic) {
      if (seen.has(key)) continue;
      trafficPoints.remove(entry.point);
      if (entry.label) trafficLabels.remove(entry.label);
      traffic.delete(key);
    }
  };
  const placeTraffic = (now: number) => {
    for (const [key, entry] of traffic) {
      if (!trafficTracks.positionAt(key, now, trafficPt)) continue;
      C.Cartesian3.fromDegrees(trafficPt.lon, trafficPt.lat, trafficPt.alt, undefined, trafficScratch);
      entry.point.position = trafficScratch; // the setters copy
      if (entry.label) entry.label.position = trafficScratch;
    }
  };
  const clearTraffic = () => {
    trafficPoints.removeAll();
    trafficLabels.removeAll();
    traffic.clear();
    trafficTracks.clear();
  };

  const pick = (x: number, y: number): TrafficPick | null => {
    if (destroyed) return null;
    let hits: unknown[];
    try {
      hits = scene.drillPick(new C.Cartesian2(x, y), 8, PICK_PX, PICK_PX);
    } catch {
      return null;
    }
    for (const hit of hits) {
      const id = (hit as { id?: Partial<TrafficPrimitiveId> } | undefined)?.id;
      if (id?.simTraffic && id.kind && id.id) return { kind: id.kind, id: id.id };
    }
    return null;
  };

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
    // `enu` is the object's local frame, computed by the render loop this frame.
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

  // --- followed-object marker (chase view only): a point plus a heading chevron ------------------
  const ownPoints: PointPrimitiveCollection = scene.primitives.add(new C.PointPrimitiveCollection());
  const ownLines: PolylineCollection = scene.primitives.add(new C.PolylineCollection());
  const ownScratch = new C.Cartesian3();
  const chevLocal = new C.Cartesian3();
  let ownKind: SimKind | null = null;
  let ownPoint: PointPrimitive | null = null;
  let ownChevron: Polyline | null = null;
  const placeOwnMarker = (pose: TrackedPose, kind: SimKind, show: boolean) => {
    if (kind !== ownKind) {
      ownKind = kind;
      ownPoints.removeAll();
      ownLines.removeAll();
      const c = C.Color.fromCssColorString(KIND_ACCENT[kind]);
      ownPoint = ownPoints.add({
        pixelSize: 10,
        color: c,
        outlineColor: C.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      ownChevron = ownLines.add({ width: 3, material: C.Material.fromType("Color", { color: c }) });
    }
    ownPoints.show = show;
    ownLines.show = show;
    if (!show || !ownPoint || !ownChevron) return;
    ownPoint.position = C.Cartesian3.fromDegrees(pose.lon, pose.lat, pose.altM, undefined, ownScratch);
    // A little above the object, so the chevron isn't lost in the sea surface or the terrain mesh.
    ownChevron.positions = chevronEnu(pose.headingDeg, chevronSizeM(chaseSpec(kind))).map((p) => {
      chevLocal.x = p.east;
      chevLocal.y = p.north;
      chevLocal.z = p.up + 1.5;
      return C.Matrix4.multiplyByPoint(enu, chevLocal, new C.Cartesian3());
    });
  };

  let cameraMode: CameraMode = "cockpit";
  const camLocal = new C.Cartesian3();
  const camWorld = new C.Cartesian3();
  const camCarto = new C.Cartographic();

  let lastPose: TrackedPose | null = null;
  const onPreRender = () => {
    const now = Date.now();
    const prev = lastPose;
    const terrain = prev ? scene.globe.getHeight(C.Cartographic.fromDegrees(prev.lon, prev.lat)) : undefined;
    const pose = opts.pose(now, terrain);
    if (!pose) return;
    lastPose = pose;
    const look = opts.look();
    const kind = opts.kind();
    const origin: Cartesian3 = C.Cartesian3.fromDegrees(pose.lon, pose.lat, pose.altM);
    C.Transforms.eastNorthUpToFixedFrame(origin, undefined, enu);
    if (cameraMode === "chase") {
      const cam = chaseCamera(pose.headingDeg, look, chaseSpec(kind));
      camLocal.x = cam.east;
      camLocal.y = cam.north;
      camLocal.z = cam.up;
      C.Matrix4.multiplyByPoint(enu, camLocal, camWorld);
      // Keep the camera above the ground behind the object (a ridge, a quay).
      const carto = C.Cartographic.fromCartesian(camWorld, undefined, camCarto);
      const ground = carto ? scene.globe.getHeight(carto) : undefined;
      const destination =
        carto && ground !== undefined && carto.height < ground + CHASE_CLEARANCE_M
          ? C.Cartesian3.fromRadians(carto.longitude, carto.latitude, ground + CHASE_CLEARANCE_M)
          : camWorld;
      widget.camera.setView({
        destination,
        orientation: { heading: C.Math.toRadians(cam.headingDeg), pitch: C.Math.toRadians(cam.pitchDeg), roll: 0 },
      });
    } else {
      widget.camera.setView({
        destination: origin,
        orientation: {
          heading: C.Math.toRadians(pose.headingDeg + look.yaw),
          pitch: C.Math.toRadians(Math.max(-89, Math.min(89, pose.pitchDeg + look.pitch))),
          roll: 0,
        },
      });
    }
    placeForwardMarker(pose, look);
    if (diag.paused) return; // nothing is drawn: skip the scene's own primitives
    placeOwnMarker(pose, kind, cameraMode === "chase");
    placeTraffic(now);
  };
  cleanups.push(scene.preRender.addEventListener(onPreRender));

  // --- rendering stopped: a software rasteriser draws nothing (globeDiag.ts shouldPauseRendering) ----
  // Cesium's render loop is turned off; a slow tick keeps the camera, the pose callback (the web HUD
  // reads the pose the globe last asked for) and the "straight ahead" marker current, without drawing.
  // The map note says why; the diagnostics line says paused=1.
  function pauseRendering() {
    if (destroyed || diag.paused) return;
    diag.paused = true;
    widget.useDefaultRenderLoop = false;
    const tick = setInterval(() => {
      if (!destroyed) onPreRender();
    }, PAUSED_TICK_MS);
    cleanups.push(() => clearInterval(tick));
    imageryReported = true;
    opts.onImagery?.("failed", PAUSED_REASON);
    lastSummary = formatDiag(diag);
    opts.onDiagnostic?.(lastSummary);
  }

  // --- route line to a known destination ----------------------------------------------------------
  const routeLines: PolylineCollection = scene.primitives.add(new C.PolylineCollection());
  const routeLine: Polyline = routeLines.add({
    width: 2.5,
    material: C.Material.fromType("Color", { color: C.Color.fromCssColorString(color.route).withAlpha(0.85) }),
    show: false,
  });
  let destination: GeoPos | null = null;
  const drawRoute = () => {
    const pose = lastPose;
    if (destroyed || !destination || !pose) {
      routeLine.show = false;
      return;
    }
    const pts = greatCirclePoints({ lat: pose.lat, lon: pose.lon, altM: pose.altM }, destination);
    routeLine.positions = pts.map((p) => C.Cartesian3.fromDegrees(p.lon, p.lat, p.altM));
    routeLine.show = true;
  };
  const routeTimer = setInterval(drawRoute, ROUTE_TICK_MS);
  cleanups.push(() => clearInterval(routeTimer));

  // --- airports + ports: labelled points, each class visible from its own distance -----------------
  // One pair of collections per filter group, so the filter hides a group in place (no refetch).
  let visibility: Partial<Record<OverlayGroup, boolean>> = {};
  const groups = new Map<OverlayGroup, { labels: LabelCollection; points: PointPrimitiveCollection }>();
  const collectionsFor = (group: OverlayGroup) => {
    let cols = groups.get(group);
    if (!cols) {
      cols = {
        labels: scene.primitives.add(new C.LabelCollection()),
        points: scene.primitives.add(new C.PointPrimitiveCollection()),
      };
      const shown = visibility[group] !== false;
      cols.labels.show = shown;
      cols.points.show = shown;
      groups.set(group, cols);
    }
    return cols;
  };
  for (const layer of opts.overlays) {
    const layerColor = C.Color.fromCssColorString(layer.color);
    // The groups this layer has drawn into (the ports layer fills both "ports" and "ferries").
    const owned = new Set<OverlayGroup>();
    const draw = (items: OverlayItem[]) => {
      for (const g of owned) {
        const cols = collectionsFor(g);
        cols.labels.removeAll();
        cols.points.removeAll();
      }
      for (const it of items) {
        owned.add(it.group);
        const { labels, points } = collectionsFor(it.group);
        const itemColor = it.color ? C.Color.fromCssColorString(it.color) : null;
        const position = C.Cartesian3.fromDegrees(it.lon, it.lat, it.altM);
        const shown = new C.DistanceDisplayCondition(0, it.rangeM);
        points.add({
          position,
          pixelSize: it.pixelSize,
          color: itemColor ?? layerColor,
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
          // Ferry quays keep their colour in the text too, so they read apart from the harbours.
          fillColor: itemColor ?? C.Color.WHITE,
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
          if (destroyed) return;
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
    setTraffic,
    setVisibility: (v) => {
      visibility = { airports: v.airports, ports: v.ports, ferries: v.ferries };
      for (const [group, cols] of groups) {
        const shown = visibility[group] !== false;
        cols.labels.show = shown;
        cols.points.show = shown;
      }
    },
    setCameraMode: (mode) => {
      cameraMode = mode;
    },
    setDestination: (dest) => {
      destination = dest;
      drawRoute();
    },
    pick,
    clearTraffic,
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
  /**
   * A single tap (not a drag, not half of a double tap) at (x, y) in CSS px relative to `el`: picks
   * traffic. Fired DOUBLE_TAP_MS after the tap, once it is clear no second tap follows.
   */
  onTap?: (x: number, y: number) => void;
}

/**
 * Drag to look around on `el` (pointer events, so mouse and touch alike), and tap to pick. A press
 * that barely moves and is released quickly is a tap (look.ts isTap); two of them in quick succession
 * are a double tap, which recenters instead of picking. Returns the cleanup.
 */
export function attachLookGestures(el: HTMLElement, h: LookGestureHandlers): () => void {
  let drag: { x: number; y: number } | null = null;
  let down: PointerMark | null = null;
  let lastTapAt = -Infinity;
  let pendingTap: ReturnType<typeof setTimeout> | null = null;
  const cancelTap = () => {
    if (pendingTap) clearTimeout(pendingTap);
    pendingTap = null;
  };
  const onDown = (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY };
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
    // Capture is a nicety (keeps the drag when the pointer leaves); a synthetic pointer can't be.
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable */
    }
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
  const onUp = (e: PointerEvent) => {
    drag = null;
    const start = down;
    down = null;
    if (!start || !h.onTap || e.type !== "pointerup") return;
    const up: PointerMark = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (!isTap(start, up)) return;
    if (up.t - lastTapAt <= DOUBLE_TAP_MS) {
      // The second half of a double tap: that recenters, it doesn't pick.
      cancelTap();
      lastTapAt = -Infinity;
      h.onReset();
      return;
    }
    lastTapAt = up.t;
    const rect = el.getBoundingClientRect();
    const x = up.x - rect.left;
    const y = up.y - rect.top;
    cancelTap();
    pendingTap = setTimeout(() => {
      pendingTap = null;
      h.onTap?.(x, y);
    }, DOUBLE_TAP_MS);
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
    cancelTap();
  };
}
