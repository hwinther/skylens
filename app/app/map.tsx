/**
 * Map tab route. The actual screen is platform-split in src/screens (MapScreen.tsx native,
 * MapScreen.web.tsx web/Leaflet) — Metro resolves the right one per platform for ORDINARY imports.
 * The split must NOT live here in the router directory: expo-router loads every file in app/ as a
 * route on every platform, so an app/map.web.tsx would get imported on Android too and its
 * top-level `leaflet` import crashes Hermes ("Property 'document' doesn't exist").
 */

export { default } from "@/screens/MapScreen";
