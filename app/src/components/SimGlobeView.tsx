"use dom";

/**
 * The Android cockpit view's 3D globe: an Expo DOM component, i.e. this file is bundled for the web and
 * runs in a webview (@expo/dom-webview) inside the native SimScreen. It hosts the same Cesium scene as
 * the web screen (src/sim/simGlobe.ts) and keeps everything per-frame inside the webview: its own
 * SimTracker dead-reckons the samples the native screen passes in, satellites are propagated here from
 * the OMM, and drag-to-look runs on the webview's pointer events.
 *
 * The webview is a separate JS context: it shares no zustand store, hub connection or token with the
 * app. So:
 *  - data comes in as props (JSON only): the latest sample (~1 Hz), the satellite's OMM, a recenter
 *    counter, whether API calls are allowed, and the cockpit extras: the other traffic (slim items,
 *    re-selected natively at ~1 Hz and only re-sent when changed), the layer visibility, the camera
 *    mode and the route destination. `targetKey` names the followed object: when "Follow this" changes
 *    it the tracker and traffic start over, without reloading the engine;
 *  - a tap on traffic is picked here (scene picking) and reported by the `onPick` native action;
 *  - everything that needs the network with auth stays native: airport/port labels are fetched by the
 *    `loadOverlay` native action (an async function prop), so no token ever enters the webview;
 *  - state goes back through native actions: onReady (first frame rendered), onFailed (no WebGL, the
 *    engine didn't load, the render loop died), onImagery (Esri imagery loaded / failed and why),
 *    onLook (the drag offset at most 4 Hz, for the native Recenter chip), onDiagnostic (the compact
 *    health summary from src/sim/globeDiag.ts every few seconds: tile counts, WebGL renderer, worker
 *    probe, pixel probe, the page's last error). The page's own console.error / window errors /
 *    unhandled rejections are counted into it. The summary is also console.info'd here, so it shows in
 *    logcat under the `chromium` tag ("[INFO:CONSOLE...] SkylensSim ...") even if the bridge is stuck.
 *
 * Cesium's runtime ships in the APK: Expo copies public/ (public/cesium from scripts/copy-cesium.mjs)
 * into the app's assets next to the exported DOM page (file:///android_asset/www.bundle/), so it loads
 * offline; only the imagery and terrain tiles need the network. See cesiumBaseUrl().
 */

import { useEffect, useRef } from "react";
import type { SatRec } from "satellite.js";
import type { DOMProps } from "expo/dom";
import type { SatelliteOmm } from "@/api/types";
import { buildSatrec, satelliteStateAt } from "@/ar/satellites";
import { AIRPORT_COLOR } from "@/components/webmap/airportStyle";
import { DIAG_TAG, formatDiag, newGlobeDiag, noteError, type GlobeDiag } from "@/sim/globeDiag";
import { PORT_COLOR } from "@/components/webmap/portStyle";
import type { CameraMode } from "@/sim/chase";
import type { SimLayerVisibility } from "@/sim/layers";
import { cesiumBaseUrl, loadCesium } from "@/sim/loadCesium";
import type { Look } from "@/sim/look";
import type { GeoPos } from "@/sim/route";
import type { TrafficItem, TrafficPick } from "@/sim/traffic";
import {
  AIRPORT_REFETCH_KM,
  PORT_REFETCH_KM,
  showsAirportOverlay,
  showsPortOverlay,
  type OverlayItem,
  type OverlayLayerKind,
} from "@/sim/overlay";
import { attachLookGestures, createSimGlobe, hasWebGL, type SimGlobe, type SimOverlayLayer } from "@/sim/simGlobe";
import { satelliteSample, type SimKind, type SimSample } from "@/sim/simPose";
import { SimTracker } from "@/sim/tracker";

/** How often the look offset may be reported to the native side. */
const LOOK_REPORT_MS = 250;

/**
 * Count the page's own errors into `diag`: console.error, uncaught errors, unhandled rejections.
 * Returns the undo.
 */
function captureErrors(diag: GlobeDiag): () => void {
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    noteError(diag, "console", args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    origError.apply(console, args);
  };
  const onError = (e: ErrorEvent) => noteError(diag, "window", e.error ?? e.message);
  const onRejection = (e: PromiseRejectionEvent) => noteError(diag, "promise", e.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    console.error = origError;
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

const LEVEL: Readonly<Look> = Object.freeze({ yaw: 0, pitch: 0 });

export interface SimGlobeViewProps {
  kind: SimKind;
  /** "kind:id" of the followed object; a change re-targets (new tracker, no traffic carried over). */
  targetKey: string;
  /** Other traffic to draw (src/sim/traffic.ts). */
  traffic: TrafficItem[];
  /** Which airport / port / ferry-quay layers are drawn. */
  layers: SimLayerVisibility;
  cameraMode: CameraMode;
  /** The route line's destination, or null. */
  destination: GeoPos | null;
  /** Native action: the user tapped this traffic in the scene. */
  onPick: (pick: TrafficPick) => Promise<void>;
  /** The followed aircraft/vessel's latest sample; null for a satellite or before the first one. */
  sample: SimSample | null;
  /** The followed satellite's orbital elements; null otherwise. */
  omm: SatelliteOmm | null;
  /** Bumped by the native Recenter button: back to straight ahead. */
  recenter: number;
  /** Whether the app may call the API (labels are skipped otherwise). */
  apiAllowed: boolean;
  /** Native action: fetch one label layer around a point. */
  loadOverlay: (layer: OverlayLayerKind, lat: number, lon: number) => Promise<OverlayItem[]>;
  onReady: () => Promise<void>;
  onFailed: (message: string) => Promise<void>;
  onImagery: (state: "loaded" | "failed", reason?: string) => Promise<void>;
  onLook: (look: Look) => Promise<void>;
  /** Native action: the diagnostic summary (formatDiag), throttled. */
  onDiagnostic: (summary: string) => Promise<void>;
  dom?: DOMProps;
}

export default function SimGlobeView(props: SimGlobeViewProps) {
  const { kind, targetKey, sample, omm, recenter, apiAllowed, traffic, layers, cameraMode, destination } = props;
  const globeRef = useRef<SimGlobe | null>(null);
  const kindRef = useRef(kind);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const markerRef = useRef<HTMLDivElement | null>(null);
  const trackerRef = useRef<SimTracker | null>(null);
  trackerRef.current ??= new SimTracker();
  const lookRef = useRef<Look>(LEVEL);
  const satrecRef = useRef<SatRec | null>(null);
  const apiAllowedRef = useRef(apiAllowed);
  // The native actions, read from the engine's callbacks (which outlive any one render).
  const actionsRef = useRef(props);
  useEffect(() => {
    actionsRef.current = props;
    apiAllowedRef.current = apiAllowed;
    kindRef.current = kind;
  });


  // Every prop change re-renders this tree with freshly deserialised props, so compare by value: a
  // sample must reach the tracker once, not on every unrelated prop change.
  // "Follow this": a new followed object starts a fresh tracker (the engine stays up), then takes the
  // new object's sample, which arrives in the same render.
  const lastSampleRef = useRef("");
  const lastTargetRef = useRef(targetKey);
  useEffect(() => {
    if (targetKey !== lastTargetRef.current) {
      lastTargetRef.current = targetKey;
      trackerRef.current = new SimTracker();
      lastSampleRef.current = "";
      lookRef.current = LEVEL;
      globeRef.current?.clearTraffic();
    }
    if (!sample) return;
    const key = JSON.stringify(sample);
    if (key === lastSampleRef.current) return;
    lastSampleRef.current = key;
    trackerRef.current?.update(sample, Date.now());
  }, [sample, targetKey]);

  // The cockpit extras, applied to the engine by value (props arrive freshly deserialised).
  const trafficRef = useRef(traffic);
  const lastTrafficRef = useRef("");
  useEffect(() => {
    trafficRef.current = traffic;
    const key = JSON.stringify(traffic);
    if (key === lastTrafficRef.current) return;
    lastTrafficRef.current = key;
    globeRef.current?.setTraffic(traffic);
  }, [traffic]);
  const layersRef = useRef(layers);
  const layersKey = JSON.stringify(layers);
  useEffect(() => {
    layersRef.current = layers;
    globeRef.current?.setVisibility(layers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layersKey]);
  const cameraRef = useRef(cameraMode);
  useEffect(() => {
    cameraRef.current = cameraMode;
    globeRef.current?.setCameraMode(cameraMode);
  }, [cameraMode]);
  const destinationRef = useRef(destination);
  const destinationKey = JSON.stringify(destination);
  useEffect(() => {
    destinationRef.current = destination;
    globeRef.current?.setDestination(destination);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationKey]);

  const lastOmmRef = useRef("");
  useEffect(() => {
    const key = omm ? JSON.stringify(omm) : "";
    if (key === lastOmmRef.current) return;
    lastOmmRef.current = key;
    satrecRef.current = omm ? buildSatrec(omm) : null;
  }, [omm]);

  useEffect(() => {
    lookRef.current = LEVEL;
  }, [recenter]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    let globe: SimGlobe | null = null;
    let failed = false;
    const diag = newGlobeDiag();
    const stopCapture = captureErrors(diag);
    const report = (summary: string) => {
      console.info(`${DIAG_TAG} ${summary}`);
      void actionsRef.current.onDiagnostic(summary);
    };
    const fail = (message: string) => {
      if (cancelled || failed) return;
      failed = true;
      noteError(diag, "failed", message);
      report(formatDiag(diag));
      void actionsRef.current.onFailed(message);
    };

    const stopGestures = attachLookGestures(el, {
      get: () => lookRef.current,
      set: (look) => {
        lookRef.current = look;
      },
      enabled: () => true,
      onReset: () => {
        lookRef.current = LEVEL;
      },
      onTap: (x, y) => {
        const hit = globeRef.current?.pick(x, y);
        if (hit) void actionsRef.current.onPick(hit);
      },
    });

    // The look offset, for the native Recenter chip: whole degrees, only on change, at most 4 Hz.
    let sentLook = "";
    const lookTimer = setInterval(() => {
      const look = lookRef.current;
      const key = `${Math.round(look.yaw)}|${Math.round(look.pitch)}`;
      if (key === sentLook) return;
      sentLook = key;
      void actionsRef.current.onLook({ yaw: look.yaw, pitch: look.pitch });
    }, LOOK_REPORT_MS);

    if (!hasWebGL()) {
      fail("This phone's WebView has no WebGL, which the 3D view needs.");
    } else {
      loadCesium(cesiumBaseUrl(process.env.EXPO_BASE_URL))
        .then((C) => {
          if (cancelled) return;
          const overlays: SimOverlayLayer[] = [];
          if (showsAirportOverlay(kind)) {
            overlays.push({
              color: AIRPORT_COLOR,
              refetchKm: AIRPORT_REFETCH_KM,
              load: (lat, lon) => actionsRef.current.loadOverlay("airports", lat, lon),
              allowed: () => apiAllowedRef.current,
            });
          }
          if (showsPortOverlay(kind)) {
            overlays.push({
              color: PORT_COLOR,
              refetchKm: PORT_REFETCH_KM,
              load: (lat, lon) => actionsRef.current.loadOverlay("ports", lat, lon),
              allowed: () => apiAllowedRef.current,
            });
          }
          try {
            globe = createSimGlobe(C, {
              container: el,
              kind: () => kindRef.current,
              marker: () => markerRef.current,
              pose: (now, terrain) => {
                // Read per frame: "Follow this" swaps in a fresh tracker.
                const tracker = trackerRef.current ?? new SimTracker();
                const satrec = satrecRef.current;
                if (satrec) {
                  const s = satelliteStateAt(satrec, new Date(now));
                  if (s) tracker.update(satelliteSample(s, now), now);
                }
                return tracker.pose(now, terrain);
              },
              look: () => lookRef.current,
              overlays,
              onFirstFrame: () => {
                if (!cancelled && !failed) void actionsRef.current.onReady();
              },
              onImagery: (state, reason) => {
                if (cancelled) return;
                console.info(`${DIAG_TAG} imagery ${state}${reason ? `: ${reason}` : ""}`);
                void actionsRef.current.onImagery(state, reason);
              },
              onRenderError: (message) => fail(`The 3D view stopped: ${message}`),
              diag,
              onDiagnostic: (summary) => {
                if (!cancelled) report(summary);
              },
            });
            globeRef.current = globe;
            // What arrived while the engine was loading.
            globe.setTraffic(trafficRef.current);
            globe.setVisibility(layersRef.current);
            globe.setCameraMode(cameraRef.current);
            globe.setDestination(destinationRef.current);
          } catch (e) {
            fail(`Couldn't start the 3D view: ${e instanceof Error ? e.message : String(e)}`);
          }
        })
        .catch((e: unknown) => {
          fail(`Couldn't load the 3D engine: ${e instanceof Error ? e.message : String(e)}`);
        });
    }

    return () => {
      cancelled = true;
      clearInterval(lookTimer);
      stopGestures();
      stopCapture();
      globe?.destroy();
      globe = null;
      globeRef.current = null;
    };
    // The engine lives for the component's lifetime; the kind never changes for a mounted globe (the
    // native screen remounts it per target).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden" }}>
      <div
        ref={containerRef}
        data-testid="sim-view"
        style={{ position: "absolute", inset: 0, touchAction: "none" }}
      />
      {/* "Straight ahead" marker, positioned every frame by the render loop (src/sim/simGlobe.ts). */}
      <div
        ref={markerRef}
        data-testid="sim-forward"
        style={{ position: "absolute", left: -14, top: -14, width: 28, height: 28, pointerEvents: "none" }}
      />
    </div>
  );
}
