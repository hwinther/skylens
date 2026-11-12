/**
 * Native Map tab. It opens on the real map when this build can draw one (an Android build with a
 * Google Maps key) and on the Radar when it can't, the Map/Radar toggle switches between them, a
 * marker opens the aircraft's detail card, and "Show on map" brings the user back from the Radar to
 * the map.
 *
 * react-native-maps is a plain-View mock (setup.ts), so markers render as pressable views; whether
 * the Maps key exists is decided by isMapAvailable, mocked per test.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import Constants from "expo-constants";
import { router } from "expo-router";
import MapScreen from "@/screens/MapScreen";
import { isMapAvailable } from "@/components/webmap/mapAvailable";
import { useMapFocusStore } from "@/state/mapFocusStore";
import { useSatelliteTrackStore } from "@/state/satelliteTrackStore";
import { aircraft, resetStores, seedAircraft } from "./fixtures";

jest.mock("@/components/webmap/mapAvailable", () => ({ isMapAvailable: jest.fn(() => true) }));
const mapAvailable = jest.mocked(isMapAvailable);

const onMap = () => screen.queryByTestId("native-map") != null;

/** The radar sizes its scope from onLayout, which never fires under jest: give it a phone's box. */
async function layoutRadar() {
  await fireEvent(screen.getByTestId("radar"), "layout", {
    nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 640 } },
  });
}

describe("MapScreen (native)", () => {
  beforeEach(() => {
    resetStores();
    seedAircraft([aircraft("abc123", { flight: "SAS123" })]);
    mapAvailable.mockReturnValue(true);
  });

  it("opens on the map, with Map first and selected in the toggle", async () => {
    await render(<MapScreen />);

    expect(onMap()).toBe(true);
    expect(screen.getByTestId("map-view-map")).toBeSelected();
    expect(screen.getByTestId("map-view-radar")).not.toBeSelected();
    // Toggle order: Map, then Radar.
    const order = screen.getAllByTestId(/^map-view-/).map((el) => el.props.testID);
    expect(order).toEqual(["map-view-map", "map-view-radar"]);
    expect(screen.getByTestId("map-aircraft-count")).toHaveTextContent("1 aircraft");
  });

  it("opens on the radar when the build has no Maps key", async () => {
    mapAvailable.mockReturnValue(false);
    await render(<MapScreen />);

    expect(onMap()).toBe(false);
    expect(screen.getByTestId("map-view-radar")).toBeSelected();
    expect(screen.getByTestId("radar")).toBeOnTheScreen();
  });

  it("switches between map and radar with the toggle", async () => {
    await render(<MapScreen />);

    await fireEvent.press(screen.getByTestId("map-view-radar"));
    expect(onMap()).toBe(false);
    expect(screen.getByTestId("radar")).toBeOnTheScreen();
    expect(screen.getByTestId("map-view-radar")).toBeSelected();

    await fireEvent.press(screen.getByTestId("map-view-map"));
    expect(onMap()).toBe(true);
    expect(screen.queryByTestId("radar")).not.toBeOnTheScreen();
  });

  it("opens the detail card from an aircraft marker on the map", async () => {
    await render(<MapScreen />);
    expect(screen.queryByTestId("detail-card")).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("map-ac-abc123"));
    expect(within(screen.getByTestId("detail-card")).getByText("SAS123")).toBeOnTheScreen();
  });

  it("goes back to the map from the radar on Show on map", async () => {
    await render(<MapScreen />);
    await fireEvent.press(screen.getByTestId("map-view-radar"));
    await layoutRadar();

    // Radar blip -> card -> "Show on map", as a user would.
    await fireEvent.press(screen.getByTestId("map-ac-abc123"));
    await fireEvent.press(screen.getByTestId("detail-show-on-map"));

    expect(useMapFocusStore.getState().focus).toEqual({ kind: "aircraft", hex: "abc123" });
    expect(router.push).toHaveBeenCalledWith("/map");
    expect(onMap()).toBe(true);
    expect(screen.queryByTestId("detail-card")).not.toBeOnTheScreen();
  });

  it("snaps to the map for a ground track selected while on the radar", async () => {
    await render(<MapScreen />);
    await fireEvent.press(screen.getByTestId("map-view-radar"));

    await act(async () => useSatelliteTrackStore.getState().setTracked(25544));
    expect(onMap()).toBe(true);
  });

  it("stays on the radar for Show on map when the build can't draw the map", async () => {
    mapAvailable.mockReturnValue(false);
    await render(<MapScreen />);

    await act(async () => useMapFocusStore.getState().setFocus({ kind: "aircraft", hex: "abc123" }));
    expect(onMap()).toBe(false);
  });
});

describe("isMapAvailable (Android)", () => {
  const { isMapAvailable: actual } = jest.requireActual<
    typeof import("@/components/webmap/mapAvailable")
  >("@/components/webmap/mapAvailable");
  const config = Constants.expoConfig as { extra?: Record<string, unknown> };
  let saved: Record<string, unknown> | undefined;
  beforeEach(() => {
    saved = config.extra;
  });
  afterEach(() => {
    config.extra = saved;
  });

  it("follows extra.hasMapsKey from app.config.js", () => {
    config.extra = { ...saved, hasMapsKey: true };
    expect(actual()).toBe(true);
    config.extra = { ...saved, hasMapsKey: false };
    expect(actual()).toBe(false);
    config.extra = { ...saved, hasMapsKey: undefined };
    expect(actual()).toBe(false);
  });
});
