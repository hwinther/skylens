/**
 * initialMapView: the Map tab opens on the geographic Map whenever this build can draw it, and on
 * the Radar otherwise (an Android build without a Google Maps key would show a blank map). A pending
 * ground track or "Show on map" request never changes the answer.
 */
import { initialMapView } from "@/components/webmap/mapView";

describe("initialMapView", () => {
  it.each`
    mapAvailable | hasTrack | hasFocus | expected
    ${true}      | ${false} | ${false} | ${"map"}
    ${true}      | ${true}  | ${false} | ${"map"}
    ${true}      | ${false} | ${true}  | ${"map"}
    ${true}      | ${true}  | ${true}  | ${"map"}
    ${false}     | ${false} | ${false} | ${"radar"}
    ${false}     | ${true}  | ${false} | ${"radar"}
    ${false}     | ${false} | ${true}  | ${"radar"}
    ${false}     | ${true}  | ${true}  | ${"radar"}
  `(
    "mapAvailable=$mapAvailable track=$hasTrack focus=$hasFocus → $expected",
    ({ mapAvailable, hasTrack, hasFocus, expected }) => {
      expect(initialMapView({ mapAvailable, hasTrack, hasFocus })).toBe(expected);
    },
  );
});
