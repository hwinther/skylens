/**
 * Android cockpit view. The globe itself (a DOM component in a webview, Cesium inside) can't run under
 * jest, so it is replaced by a stub that records its props: the tests drive its native actions
 * (onReady / onFailed / onImagery / onLook / loadOverlay) and check what the native screen does with
 * them — the loading, ready and failed states, the HUD from the live store, Recenter, and the ways out
 * (Exit, the failure card's Back, the hardware back button). Then the cockpit extras: the detail card,
 * the traffic handed to the globe, a pick → card → "Follow this", the layer filter, the outside view,
 * and the nearest-airport / destination aids.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { DeviceEventEmitter, Dimensions, StyleSheet } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import SimScreen, { GLOBE_START_TIMEOUT_MS } from "@/screens/SimScreen";
import { HUD_COLUMN_GAP, hudMaxWidth } from "@/sim/layout";
import type { SimGlobeViewProps } from "@/components/SimGlobeView";
import { useSimStore } from "@/state/simStore";
import { useMapFocusStore } from "@/state/mapFocusStore";
import { useAuthStore } from "@/state/authStore";
import { useSettingsStore } from "@/state/settingsStore";
import { useVesselStore } from "@/state/vesselStore";
import { aircraft, backendJson, resetStores, routeFetch, seedAircraft } from "./fixtures";

// The latest props the globe was rendered with (null once unmounted).
const mockGlobe: { props: SimGlobeViewProps | null; renders: number } = { props: null, renders: 0 };

jest.mock("@/components/SimGlobeView", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  function SimGlobeViewStub(props: SimGlobeViewProps) {
    mockGlobe.props = props;
    mockGlobe.renders += 1;
    React.useEffect(() => {
      return () => {
        mockGlobe.props = null;
      };
    }, []);
    return React.createElement(View, { testID: "sim-globe-webview" });
  }
  return { __esModule: true, default: SimGlobeViewStub };
});

const globe = () => {
  if (!mockGlobe.props) throw new Error("the globe is not mounted");
  return mockGlobe.props;
};

async function tick(ms = 300) {
  await act(async () => jest.advanceTimersByTime(ms));
}

async function renderSim(kind = "aircraft", id = "abc123") {
  jest.mocked(useLocalSearchParams).mockReturnValue({ kind, id });
  await render(<SimScreen />);
  await tick();
}

describe("SimScreen (Android)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetStores();
    mockGlobe.props = null;
    mockGlobe.renders = 0;
    useSimStore.setState({ target: null, centre: null });
    seedAircraft([aircraft("abc123", { flight: "SAS123 ", alt: 10000, gs: 250, trk: 90 })]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("starts the session, feeds the globe the live sample and shows the HUD while the globe loads", async () => {
    await renderSim();

    expect(useSimStore.getState().target).toEqual({ kind: "aircraft", id: "abc123" });
    expect(screen.getByTestId("sim-globe-loading")).toBeOnTheScreen();
    expect(screen.getByTestId("sim-globe-spinner")).toHaveTextContent("Starting the 3D globe…");
    expect(screen.getByTestId("sim-status")).toHaveTextContent("Loading 3D view…");
    expect(screen.getByTestId("sim-name")).toHaveTextContent("SAS123");
    expect(screen.getByTestId("sim-alt")).toHaveTextContent("10000 ft");
    expect(screen.getByTestId("sim-heading")).toHaveTextContent("90°");

    const props = globe();
    expect(props.kind).toBe("aircraft");
    expect(props.sample).toMatchObject({ kind: "aircraft", lat: 59.95, lon: 10.8, headingDeg: 90 });
    expect(props.omm).toBeNull();
    expect(props.apiAllowed).toBe(false); // signed out behind real auth (setup)

    // A new snapshot reaches the globe as a new sample prop.
    await act(async () => seedAircraft([aircraft("abc123", { flight: "SAS123", lat: 60.0, lon: 10.8 })]));
    await tick();
    expect(globe().sample).toMatchObject({ lat: 60.0 });
  });

  it("shows the ready state once the globe has rendered its first frame", async () => {
    await renderSim();
    await act(() => globe().onReady());

    expect(screen.getByTestId("sim-globe-ready")).toBeOnTheScreen();
    expect(screen.queryByTestId("sim-globe-spinner")).toBeNull();
    expect(screen.getByTestId("sim-status")).toHaveTextContent(/Live|Data \d+ s old/);
    expect(screen.getByLabelText("3D globe ready")).toBeOnTheScreen();

    await act(() => globe().onImagery("loaded"));
    expect(screen.getByLabelText("3D globe ready, imagery loaded")).toBeOnTheScreen();
    expect(screen.queryByTestId("sim-imagery-failed")).toBeNull();
  });

  it("notes missing imagery (offline) without failing the view", async () => {
    await renderSim();
    await act(() => globe().onReady());
    await act(() => globe().onImagery("failed"));

    expect(screen.getByTestId("sim-globe-ready")).toBeOnTheScreen();
    expect(screen.getByTestId("sim-imagery-failed")).toHaveTextContent(/imagery unavailable \(offline\?\)/);
  });

  it("says why the imagery is missing when the globe knows", async () => {
    await renderSim();
    await act(() => globe().onReady());
    await act(() => globe().onImagery("failed", "this device's graphics drew nothing"));

    expect(screen.getByLabelText("3D globe ready, imagery failed")).toBeOnTheScreen();
    expect(screen.getByTestId("sim-imagery-failed")).toHaveTextContent(
      "Map imagery unavailable (this device's graphics drew nothing)",
    );
  });

  it("logs the globe's diagnostics with a stable prefix, and keeps them off screen in normal builds", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await renderSim();
      await act(() => globe().onDiagnostic("gl=webgl2 X|tex=4096|wk=ok"));
      expect(log).toHaveBeenCalledWith("SkylensSim gl=webgl2 X|tex=4096|wk=ok");
      expect(screen.queryByTestId("sim-globe-diag")).toBeNull(); // only with EXPO_PUBLIC_SIM_DIAG=1
    } finally {
      log.mockRestore();
    }
  });

  it("does not re-render the globe on every HUD tick", async () => {
    await renderSim();
    const before = mockGlobe.renders;
    await tick(2000); // eight HUD ticks, no new sample
    expect(mockGlobe.renders).toBe(before);
  });

  it("shows the failure card with the reason, drops the webview, and Back leaves", async () => {
    await renderSim();
    await act(() => globe().onFailed("This phone's WebView has no WebGL, which the 3D view needs."));

    expect(screen.getByTestId("sim-globe-failed")).toBeOnTheScreen();
    expect(screen.getByTestId("sim-globe-error")).toHaveTextContent(/no WebGL/);
    expect(screen.queryByTestId("sim-globe-webview")).toBeNull();
    // The HUD keeps showing the live data.
    expect(screen.getByTestId("sim-name")).toHaveTextContent("SAS123");

    await fireEvent.press(screen.getByTestId("sim-globe-back"));
    expect(router.replace).toHaveBeenCalledWith("/");
  });

  it("fails if the globe never reports back", async () => {
    await renderSim();
    await tick(GLOBE_START_TIMEOUT_MS);

    expect(screen.getByTestId("sim-globe-failed")).toBeOnTheScreen();
    expect(screen.getByTestId("sim-globe-error")).toHaveTextContent(/didn't start in time/);
  });

  it("does not time out once the globe is ready", async () => {
    await renderSim();
    await act(() => globe().onReady());
    await tick(GLOBE_START_TIMEOUT_MS + 1000);
    expect(screen.getByTestId("sim-globe-ready")).toBeOnTheScreen();
  });

  it("shows Recenter while the view is dragged off straight ahead and recenters the globe", async () => {
    await renderSim();
    expect(screen.queryByTestId("sim-recenter")).toBeNull();

    await act(() => globe().onLook({ yaw: 42, pitch: 0 }));
    expect(screen.getByTestId("sim-look-offset")).toHaveTextContent(/42° right/);
    const before = globe().recenter;

    await fireEvent.press(screen.getByTestId("sim-recenter"));
    expect(screen.queryByTestId("sim-recenter")).toBeNull();
    expect(globe().recenter).toBe(before + 1);
  });

  it("closes the card on the hardware back button first, then leaves and ends the session", async () => {
    jest.mocked(router.canGoBack).mockReturnValue(true);
    jest.mocked(useLocalSearchParams).mockReturnValue({ kind: "aircraft", id: "abc123" });
    const view = await render(<SimScreen />);
    await tick();
    expect(screen.getByTestId("detail-card")).toBeOnTheScreen();

    await act(async () => {
      DeviceEventEmitter.emit("hardwareBackPress");
    });
    expect(screen.queryByTestId("detail-card")).toBeNull();
    expect(router.back).not.toHaveBeenCalled();

    await act(async () => {
      DeviceEventEmitter.emit("hardwareBackPress");
    });
    expect(router.back).toHaveBeenCalled();

    await view.unmount();
    expect(useSimStore.getState().target).toBeNull();
  });

  it("Exit goes back, Map opens the full map following the aircraft", async () => {
    await renderSim();
    await fireEvent.press(screen.getByTestId("sim-open-map"));
    expect(useMapFocusStore.getState().focus).toEqual({ kind: "aircraft", hex: "abc123" });
    expect(router.push).toHaveBeenCalledWith("/map");

    await fireEvent.press(screen.getByTestId("sim-exit"));
    expect(router.replace).toHaveBeenCalledWith("/");
  });

  it("refuses label fetches while the API is gated, so the globe retries later", async () => {
    await renderSim();
    await expect(globe().loadOverlay("airports", 59.9, 10.75)).rejects.toThrow(/not allowed/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("asks to sign in for a satellite's orbit when signed out, and still offers the globe", async () => {
    await renderSim("satellite", "25544");
    expect(screen.getByTestId("sim-name")).toHaveTextContent("NORAD 25544");
    expect(screen.getByTestId("sim-status")).toHaveTextContent("Sign in to load the satellite's orbit.");
    expect(globe().kind).toBe("satellite");
    expect(globe().omm).toBeNull();
  });

  it("without a target, says so and offers Back", async () => {
    jest.mocked(useLocalSearchParams).mockReturnValue({});
    await render(<SimScreen />);
    expect(screen.getByText(/Nothing to follow/)).toBeOnTheScreen();
    expect(mockGlobe.props).toBeNull();
    await fireEvent.press(screen.getByTestId("sim-exit"));
    expect(router.replace).toHaveBeenCalledWith("/");
  });
});

describe("SimScreen (Android) cockpit extras", () => {
  /** Chip state: `aria-pressed` (what web renders) and `selected` (the native accessibility state). */
  const pressed = (testID: string) => {
    const chip = screen.getByTestId(testID);
    expect(chip.props.accessibilityState?.selected).toBe(chip.props["aria-pressed"]);
    return chip.props["aria-pressed"] as boolean;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    resetStores();
    mockGlobe.props = null;
    mockGlobe.renders = 0;
    useSimStore.setState({ target: null, centre: null });
    useSettingsStore.setState({ simHiddenLayers: [] });
    seedAircraft([
      aircraft("abc123", { flight: "SAS123 ", alt: 10000, gs: 250, trk: 90 }),
      // ~3 km north: drawn and labelled with its relative altitude (1 200 ft above).
      aircraft("def456", { flight: "NOZ77", lat: 59.977, lon: 10.8, alt: 11200, gs: 200, trk: 180 }),
      // ~150 km away: out of the 50 km traffic range.
      aircraft("far999", { flight: "FAR1", lat: 61.3, lon: 10.8, alt: 30000 }),
    ]);
    useVesselStore.getState().setSnapshot([
      { mmsi: "257000001", kind: "ship", name: "COLOR MAGIC", lat: 59.94, lon: 10.79, sog: 12, cog: 200, seen: 1 },
      { mmsi: "992570001", kind: "aton", name: "BUOY", lat: 59.94, lon: 10.8 },
    ]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("opens the followed aircraft's card collapsed, without a cockpit action, and Details reopens it", async () => {
    await renderSim();
    expect(screen.getByTestId("detail-card")).toBeOnTheScreen();
    expect(screen.getByTestId("detail-title")).toHaveTextContent("SAS123");
    expect(screen.getByTestId("detail-card-summary")).toBeOnTheScreen();
    expect(screen.queryByTestId("detail-cockpit")).toBeNull();
    expect(screen.queryByTestId("sim-follow")).toBeNull();
    expect(screen.queryByTestId("sim-details")).toBeNull();

    // Expands like the AR card.
    await fireEvent.press(screen.getByTestId("detail-card-toggle"));
    expect(screen.getByTestId("detail-card-body")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("detail-card-close"));
    expect(screen.queryByTestId("detail-card")).toBeNull();
    await fireEvent.press(screen.getByTestId("sim-details"));
    expect(screen.getByTestId("detail-title")).toHaveTextContent("SAS123");
  });

  it("hands the globe the nearby traffic (not the followed one, not too far, no aids to navigation)", async () => {
    await renderSim();
    await tick(1000);
    const traffic = globe().traffic;
    expect(traffic.map((t) => `${t.kind}:${t.id}`).sort()).toEqual(["aircraft:def456", "vessel:257000001"]);
    expect(traffic.find((t) => t.id === "def456")?.label).toBe("NOZ77 +12");
    expect(traffic.find((t) => t.id === "257000001")?.label).toBe("COLOR MAGIC");
  });

  it("a tap on traffic opens its card; only Follow this switches the cockpit to it", async () => {
    await renderSim();
    await act(() => globe().onPick({ kind: "aircraft", id: "def456" }));

    expect(screen.getByTestId("detail-title")).toHaveTextContent("NOZ77");
    // Opening the card follows nothing yet.
    expect(useSimStore.getState().target).toEqual({ kind: "aircraft", id: "abc123" });
    expect(router.setParams).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId("sim-follow"));
    expect(useSimStore.getState().target).toEqual({ kind: "aircraft", id: "def456" });
    expect(router.setParams).toHaveBeenCalledWith({ kind: "aircraft", id: "def456" });

    // The route params change: the session re-targets, the globe stays mounted and starts over.
    const renders = mockGlobe.renders;
    jest.mocked(useLocalSearchParams).mockReturnValue({ kind: "aircraft", id: "def456" });
    await screen.rerender(<SimScreen />);
    await tick();
    expect(mockGlobe.renders).toBeGreaterThan(renders);
    expect(globe().targetKey).toBe("aircraft:def456");
    expect(globe().sample).toMatchObject({ lat: 59.977 });
    expect(screen.getByTestId("sim-name")).toHaveTextContent("NOZ77");
    expect(useSimStore.getState().target).toEqual({ kind: "aircraft", id: "def456" });
    expect(useSimStore.getState().centre).not.toBeNull();
    // The card now shows the followed aircraft, so no Follow action.
    expect(screen.getByTestId("detail-title")).toHaveTextContent("NOZ77");
    expect(screen.queryByTestId("sim-follow")).toBeNull();
  });

  it("a tapped vessel's card offers Follow this too", async () => {
    await renderSim();
    await act(() => globe().onPick({ kind: "vessel", id: "257000001" }));
    expect(screen.getByTestId("vessel-detail-title")).toHaveTextContent("COLOR MAGIC");
    expect(screen.queryByTestId("vessel-cockpit")).toBeNull();
    await fireEvent.press(screen.getByTestId("sim-follow"));
    expect(router.setParams).toHaveBeenCalledWith({ kind: "vessel", id: "257000001" });
  });

  it("the Layers filter unfolds, hides a layer, persists it and tells the globe", async () => {
    await renderSim();
    expect(screen.queryByTestId("sim-filter-panel")).toBeNull();
    await fireEvent.press(screen.getByTestId("sim-filter"));
    expect(screen.getByTestId("sim-filter").props.accessibilityState?.expanded).toBe(true);
    for (const layer of ["aircraft", "vessels", "airports", "ports", "ferries"]) {
      expect(pressed(`sim-filter-${layer}`)).toBe(true);
    }

    await fireEvent.press(screen.getByTestId("sim-filter-aircraft"));
    await fireEvent.press(screen.getByTestId("sim-filter-ferries"));
    expect(pressed("sim-filter-aircraft")).toBe(false);
    expect(useSettingsStore.getState().simHiddenLayers).toEqual(["aircraft", "ferries"]);
    expect(globe().layers).toMatchObject({ aircraft: false, vessels: true, ports: true, ferries: false });
    expect(screen.getByTestId("sim-filter")).toHaveTextContent("Layers · 2 hidden");

    await tick(1000);
    expect(globe().traffic.map((t) => t.kind)).toEqual(["vessel"]);
  });

  it("keeps the HUD left of the control column (measured), so the chips never cover its values", async () => {
    await renderSim();
    const { width } = Dimensions.get("window");
    const hudMax = () => StyleSheet.flatten(screen.getByTestId("sim-hud").props.style).maxWidth as number;
    // Before the column is measured: a typical column width is assumed.
    expect(hudMax()).toBe(hudMaxWidth({ windowWidth: width, hudLeft: 12, columnRight: 12, columnWidth: 0 }));

    await fireEvent(screen.getByTestId("sim-controls"), "layout", {
      nativeEvent: { layout: { x: width - 12 - 104, y: 12, width: 104, height: 200 } },
    });
    expect(hudMax()).toBe(width - 12 - 12 - 104 - HUD_COLUMN_GAP);
    expect(12 + hudMax() + HUD_COLUMN_GAP).toBeLessThanOrEqual(width - 12 - 104);
  });

  it("has no filter when following a satellite", async () => {
    await renderSim("satellite", "25544");
    expect(screen.queryByTestId("sim-filter")).toBeNull();
    expect(screen.getByTestId("sim-camera-toggle")).toBeOnTheScreen();
  });

  it("the outside view toggles the globe's camera, and Recenter still works there", async () => {
    await renderSim();
    expect(pressed("sim-camera-toggle")).toBe(false);
    expect(globe().cameraMode).toBe("cockpit");

    await fireEvent.press(screen.getByTestId("sim-camera-toggle"));
    expect(pressed("sim-camera-toggle")).toBe(true);
    expect(globe().cameraMode).toBe("chase");

    await act(() => globe().onLook({ yaw: 90, pitch: 0 }));
    const before = globe().recenter;
    await fireEvent.press(screen.getByTestId("sim-recenter"));
    expect(globe().recenter).toBe(before + 1);
    expect(globe().cameraMode).toBe("chase");
  });

  it("shows the nearest airport and a known destination (cached route only), with the route line", async () => {
    useAuthStore.setState({ authRequired: false });
    const airport = (ident: string, name: string, type: string, lat: number, lon: number) => ({
      ident,
      name,
      type,
      lat,
      lon,
      elevationFt: 500,
      runways: [],
      frequencies: [],
    });
    const requested = routeFetch({
      "/api/aircraft/abc123": () => backendJson({ metadata: { hex: "abc123", typeCode: "B738" } }),
      "/api/aircraft/abc123/route/cached": () =>
        backendJson({ ident: "SAS123", originIcao: "ESSA", destinationIcao: "ENGM" }),
      "/api/airports": () =>
        backendJson({
          airports: [
            airport("ENGM", "Oslo Gardermoen", "large_airport", 60.1939, 11.1004),
            airport("ENKJ", "Kjeller", "small_airport", 59.9693, 11.0361),
          ],
        }),
    });
    await renderSim();
    await act(async () => {});
    const items = await act(() => globe().loadOverlay("airports", 59.95, 10.8));
    expect(items.map((i) => i.label)).toEqual(["ENGM", "ENKJ"]);
    await tick(1000);

    expect(screen.getByTestId("sim-nearest")).toHaveTextContent(/^ENKJ \d+ km E$/);
    expect(screen.getByTestId("sim-dest")).toHaveTextContent(/^ENGM \d+ km$/);
    expect(globe().destination).toMatchObject({ lat: 60.1939, lon: 11.1004 });
    // Never the paid lookup.
    expect(requested).not.toContain("/api/aircraft/abc123/route");
  });
});
