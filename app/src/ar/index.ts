/** Barrel for the pure-TS AR math pipeline. */
export * from "./geo";
export * from "./orientation";
export * from "./webOrientation";
export * from "./projection";
export * from "./smoothing";
export * from "./declutter";
export * from "./surfaceBand";
export * from "./satellites";
export * from "./planets";
export * from "./radioSky";
export * from "./polaris";
export * from "./jupiterMoons";
export * from "./skyEvents";
// Selective: moon.ts also exports SPEED_OF_LIGHT_KM_S (identical value), already surfaced by ./satellites —
// re-export only the EME-specific names to avoid a duplicate-export clash through the barrel.
export { moonEmeInfo, MEAN_MOON_DISTANCE_KM, type MoonEmeInfo } from "./moon";
export * from "./visibility";
