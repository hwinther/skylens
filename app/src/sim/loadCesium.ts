/**
 * Lazily load Cesium's prebuilt runtime from /cesium (copied there by scripts/copy-cesium.mjs) with a
 * <script> tag, once, the first time the simulator opens. Only the npm package's TYPES are imported, so
 * Metro never bundles Cesium and the main bundle stays small. Same-origin script, stylesheet and
 * workers keep the CSP at 'self'. Runs in a browser: the web app, or the Android globe's DOM-component
 * webview, which passes its own base (Cesium ships inside the APK there, see cesiumBaseUrl).
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

/**
 * Cesium's base URL from an Expo base URL (`process.env.EXPO_BASE_URL`). The web app and a DOM
 * component in development have "" (public/ is served at the server root → "/cesium/"). An exported
 * DOM component has "./": its page is www.bundle/<hash>.html in the APK's assets and public/ is copied
 * next to it (www.bundle/cesium/), so the runtime is a sibling directory.
 */
export function cesiumBaseUrl(expoBaseUrl: string | undefined): string {
  const base = expoBaseUrl ?? "";
  if (!base) return CESIUM_BASE;
  return `${base.endsWith("/") ? base : `${base}/`}cesium/`;
}

let loading: Promise<Cesium> | null = null;

export function loadCesium(base: string = CESIUM_BASE): Promise<Cesium> {
  if (typeof window === "undefined") return Promise.reject(new Error("Cesium needs a browser"));
  if (window.Cesium) return Promise.resolve(window.Cesium);
  loading ??= new Promise<Cesium>((resolve, reject) => {
    // Absolute, so Cesium resolves its workers and assets the same way from any page path.
    const baseUrl = new URL(base, document.baseURI).href;
    window.CESIUM_BASE_URL = baseUrl;

    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${baseUrl}Widgets/widgets.css`;
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = `${baseUrl}Cesium.js`;
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
