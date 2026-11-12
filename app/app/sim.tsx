/**
 * Simulator (cockpit view) route: /sim?kind=aircraft|vessel|satellite&id=…. The screen is
 * platform-split in src/screens (SimScreen.web.tsx: Cesium; SimScreen.tsx: native placeholder). The
 * split must not live here — see map.tsx for why a .web file in app/ would crash Hermes.
 */

export { default } from "@/screens/SimScreen";
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteErrorBoundary";
