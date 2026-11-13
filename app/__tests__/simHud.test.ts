/**
 * Cockpit-view pieces shared by the web and Android screens: the HUD text, the /sim route params, and
 * where Cesium's runtime is loaded from (web origin vs. the APK's DOM-component assets).
 */

import { hudRows, statusText } from "@/sim/hud";
import { cesiumBaseUrl } from "@/sim/loadCesium";
import { parseTarget } from "@/sim/target";
import type { TrackedPose } from "@/sim/tracker";

const pose = (over: Partial<TrackedPose> = {}): TrackedPose => ({
  lat: 60,
  lon: 11,
  altM: 3048,
  headingDeg: 360.4,
  pitchDeg: -6,
  speedMps: 128.6,
  ageS: 1,
  stale: false,
  ...over,
});

test("status: errors first, then position, staleness, the engine, and the data's age", () => {
  expect(statusText(pose(), true, "Couldn't load the satellite's orbit.")).toBe("Couldn't load the satellite's orbit.");
  expect(statusText(null, true, null)).toBe("Waiting for position…");
  expect(statusText(pose({ stale: true }), true, null)).toBe("Signal lost — holding last position");
  expect(statusText(pose(), false, null)).toBe("Loading 3D view…");
  expect(statusText(pose(), true, null)).toBe("Live");
  expect(statusText(pose({ ageS: 12.4 }), true, null)).toBe("Data 12 s old");
  expect(statusText(pose({ ageS: 300 }), true, null)).toBe("Data 5 min old");
});

test("HUD rows per kind keep the sim-* testIDs and units", () => {
  expect(hudRows("aircraft", pose())).toEqual([
    ["ALT", "10000 ft", "sim-alt"],
    ["SPD", "250 kt", "sim-speed"],
    ["HDG", "0°", "sim-heading"],
    ["PITCH", "-6.0°", "sim-pitch"],
  ]);
  expect(hudRows("vessel", pose()).map((r) => r[2])).toEqual(["sim-speed", "sim-heading"]);
  expect(hudRows("satellite", pose({ altM: 420_000, speedMps: 7660 }))).toEqual([
    ["ALT", "420 km", "sim-alt"],
    ["SPD", "7.66 km/s", "sim-speed"],
    ["HDG", "0°", "sim-heading"],
  ]);
});

test("route params parse to a target only for known kinds with an id", () => {
  expect(parseTarget("aircraft", "4ca1b2")).toEqual({ kind: "aircraft", id: "4ca1b2" });
  expect(parseTarget("satellite", "25544")).toEqual({ kind: "satellite", id: "25544" });
  expect(parseTarget("planet", "mars")).toBeNull();
  expect(parseTarget("vessel", "")).toBeNull();
  expect(parseTarget(undefined, "x")).toBeNull();
});

test("Cesium loads from /cesium/ on the web and next to the exported DOM page in the APK", () => {
  expect(cesiumBaseUrl(undefined)).toBe("/cesium/");
  expect(cesiumBaseUrl("")).toBe("/cesium/"); // web, and a DOM component served by the dev server
  expect(cesiumBaseUrl("./")).toBe("./cesium/"); // exported DOM component (www.bundle/<hash>.html)
  expect(cesiumBaseUrl("/skylens")).toBe("/skylens/cesium/");
});
