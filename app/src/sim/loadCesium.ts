/**
 * Lazily load Cesium's prebuilt runtime from /cesium (copied there by scripts/copy-cesium.mjs) with a
 * <script> tag, once, the first time the simulator opens. Only the npm package's TYPES are imported, so
 * Metro never bundles Cesium and the main bundle stays small. Same-origin script, stylesheet and
 * workers keep the CSP at 'self'. Web only.
 */

import type * as CesiumNS from "cesium";

export type Cesium = typeof CesiumNS;

declare global {
  interface Window {
    Cesium?: Cesium;
    CESIUM_BASE_URL?: string;
  }
}

/** Where the runtime is served; also Cesium's base URL for its workers and assets. */
export const CESIUM_BASE = "/cesium/";

let loading: Promise<Cesium> | null = null;

export function loadCesium(): Promise<Cesium> {
  if (typeof window === "undefined") return Promise.reject(new Error("Cesium needs a browser"));
  if (window.Cesium) return Promise.resolve(window.Cesium);
  loading ??= new Promise<Cesium>((resolve, reject) => {
    window.CESIUM_BASE_URL = CESIUM_BASE;

    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${CESIUM_BASE}Widgets/widgets.css`;
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = `${CESIUM_BASE}Cesium.js`;
    script.async = true;
    script.onload = () => {
      if (window.Cesium) resolve(window.Cesium);
      else reject(new Error("Cesium.js loaded but window.Cesium is missing"));
    };
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error(`Failed to load ${script.src}`));
    };
    document.head.appendChild(script);
  });
  return loading;
}
