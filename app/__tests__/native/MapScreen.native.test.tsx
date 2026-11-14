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
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { router } from "expo-router";
import MapScreen from "@/screens/MapScreen";
import { isMapAvailable } from "@/components/webmap/mapAvailable";
import { useMapFocusStore } from "@/state/mapFocusStore";
import { useSatelliteTrackStore } from "@/state/satelliteTrackStore";
import { useSettingsStore } from "@/state/settingsStore";
import { useAuthStore } from "@/state/authStore";
import {
  aircraft,
  backendJson,
  ISS_DTO,
  ISS_PASS_TIME,
  resetStores,
  routeFetch,
  seedAircraft,
} from "./fixtures";

jest.mock("@/components/webmap/mapAvailable", () => ({ isMapAvailable: jest.fn(() => true) }));
const mapAvailable = jest.mocked(isMapAvailable);

/** The app root wraps every screen in a GestureHandlerRootView (the radar's tilt control is a gesture). */
const renderScreen = () =>
  render(
    <GestureHandlerRootView>
      <MapScreen />
    </GestureHandlerRootView>,
  );

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
    await renderScreen();

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
    await renderScreen();

    expect(onMap()).toBe(false);
    expect(screen.getByTestId("map-view-radar")).toBeSelected();
    expect(screen.getByTestId("radar")).toBeOnTheScreen();
  });

  it("switches between map and radar with the toggle", async () => {
    await renderScreen();

    await fireEvent.press(screen.getByTestId("map-view-radar"));
    expect(onMap()).toBe(false);
    expect(screen.getByTestId("radar")).toBeOnTheScreen();
    expect(screen.getByTestId("map-view-radar")).toBeSelected();

    await fireEvent.press(screen.getByTestId("map-view-map"));
    expect(onMap()).toBe(true);
    expect(screen.queryByTestId("radar")).not.toBeOnTheScreen();
  });

  it("opens the detail card from an aircraft marker on the map", async () => {
    await renderScreen();
    expect(screen.queryByTestId("detail-card")).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("map-ac-abc123"));
    expect(within(screen.getByTestId("detail-card")).getByText("SAS123")).toBeOnTheScreen();
  });

  it("goes back to the map from the radar on Show on map", async () => {
    await renderScreen();
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
    await renderScreen();
    await fireEvent.press(screen.getByTestId("map-view-radar"));

    await act(async () => useSatelliteTrackStore.getState().setTracked(25544));
    expect(onMap()).toBe(true);
  });

  it("stays on the radar for Show on map when the build can't draw the map", async () => {
    mapAvailable.mockReturnValue(false);
    await renderScreen();

    await act(async () => useMapFocusStore.getState().setFocus({ kind: "aircraft", hex: "abc123" }));
    expect(onMap()).toBe(false);
  });
});

/**
 * Satellites layer: the real useSatellites chain (routed GET /api/satellites → SGP4) at a pinned ISS
 * pass over the demo home, so the ISS is "Overhead" exactly as the List would show it.
 */
describe("MapScreen (native) — satellites layer", () => {
  const SAT_DETAIL = { satellite: ISS_DTO, transmitters: [] };

  beforeEach(() => {
    resetStores();
    mapAvailable.mockReturnValue(true);
    jest.useFakeTimers({ now: ISS_PASS_TIME });
    useAuthStore.setState({ authRequired: false });
    useSettingsStore.setState({ showSatellites: true, showMapSatellites: true });
    routeFetch({
      "/api/satellites": () => backendJson({ tleAgeSeconds: 3600, satellites: [ISS_DTO] }),
      "/api/satellites/25544": () => backendJson(SAT_DETAIL),
    });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  async function renderMap() {
    await renderScreen();
    await act(async () => {}); // the satellites fetch resolves, the first tick places them
  }

  it("draws the overhead satellites at their sub-satellite points", async () => {
    await renderMap();
    expect(screen.getByTestId("map-sat-25544")).toBeOnTheScreen();
    expect(screen.queryByTestId("map-sat-footprint")).not.toBeOnTheScreen();
  });

  it("opens the satellite card on a tap and draws that satellite's footprint", async () => {
    await renderMap();
    await fireEvent.press(screen.getByTestId("map-sat-25544"));
    await act(async () => {});

    expect(screen.getByTestId("sat-detail-title")).toHaveTextContent("ISS (ZARYA)");
    expect(screen.getAllByTestId("map-sat-footprint").length).toBeGreaterThan(0);

    // Closing the card drops the footprint again.
    await fireEvent.press(screen.getByTestId("detail-card-close"));
    expect(screen.queryByTestId("map-sat-footprint")).not.toBeOnTheScreen();
  });

  it("hides the layer (and its footprint) when switched off in Settings", async () => {
    await renderMap();
    expect(screen.getByTestId("map-sat-25544")).toBeOnTheScreen();

    await act(async () => useSettingsStore.getState().setShowMapSatellites(false));
    expect(screen.queryByTestId("map-sat-25544")).not.toBeOnTheScreen();

    // The master satellites switch turns it off too.
    await act(async () => useSettingsStore.setState({ showMapSatellites: true, showSatellites: false }));
    expect(screen.queryByTestId("map-sat-25544")).not.toBeOnTheScreen();
  });

  it("draws a tracked overhead satellite once, with its footprint", async () => {
    await renderMap();
    await act(async () => useSatelliteTrackStore.getState().setTracked(25544));
    await act(async () => {});

    expect(screen.getAllByTestId("map-sat-25544")).toHaveLength(1);
    expect(screen.queryByTestId("map-sat-track-point")).not.toBeOnTheScreen();
    expect(screen.getAllByTestId("map-sat-footprint").length).toBeGreaterThan(0);

    // Layer off: the ground track's own marker comes back.
    await act(async () => useSettingsStore.getState().setShowMapSatellites(false));
    expect(screen.getByTestId("map-sat-track-point")).toBeOnTheScreen();
    expect(screen.queryByTestId("map-sat-footprint")).not.toBeOnTheScreen();
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

describe("MapScreen (native) radar tilt", () => {
  beforeEach(() => {
    resetStores();
    seedAircraft([aircraft("abc123", { flight: "SAS123" })]);
    mapAvailable.mockReturnValue(false);
    useSettingsStore.setState({ radarTiltDeg: 0, demoMode: true });
  });

  it("tilts the radar from its control, remembers the tilt in settings and draws the demo relief", async () => {
    await renderScreen();
    await layoutRadar();
    expect(screen.queryByTestId("radar-terrain")).not.toBeOnTheScreen();

    await fireEvent(screen.getByTestId("radar-tilt"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });

    expect(useSettingsStore.getState().radarTiltDeg).toBe(15);
    expect(screen.getByTestId("radar-tilt-value")).toHaveTextContent("15°");
    expect(screen.getByTestId("radar-terrain")).toBeOnTheScreen();
    expect(screen.getByTestId("map-ac-abc123")).toBeOnTheScreen();
  });
});
