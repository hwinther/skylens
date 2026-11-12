/**
 * Which of the Map tab's two spatial renderings is shown: the real geographic Map, or the
 * you-centric, offline Radar. Pure policy, shared by both Map screens (MapScreen.tsx native,
 * MapScreen.web.tsx web) through useMapViewMode, and jest-tested.
 */

export type MapView = "radar" | "map";

export interface InitialMapViewInput {
  /** A satellite ground track is selected ("Show ground track"); it only renders on the Map. */
  hasTrack: boolean;
  /** A "Show on map" request is pending; only the Map can centre on a target. */
  hasFocus: boolean;
  /** The Map can actually draw here (see mapAvailable.ts); otherwise it would be blank. */
  mapAvailable: boolean;
}

/**
 * The view the Map tab opens on. The Map is the default whenever it can draw; a pending track or
 * focus asks for the Map too, so they never change the answer while it is available. Without it
 * (an Android build with no Google Maps key) the tab opens on the Radar, even for a track or focus:
 * a blank map shows neither.
 */
export function initialMapView({ mapAvailable }: InitialMapViewInput): MapView {
  return mapAvailable ? "map" : "radar";
}
