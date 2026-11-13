/**
 * Android cockpit view. The globe itself (a DOM component in a webview, Cesium inside) can't run under
 * jest, so it is replaced by a stub that records its props: the tests drive its native actions
 * (onReady / onFailed / onImagery / onLook / loadOverlay) and check what the native screen does with
 * them — the loading, ready and failed states, the HUD from the live store, Recenter, and the ways out
 * (Exit, the failure card's Back, the hardware back button).
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { DeviceEventEmitter } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import SimScreen, { GLOBE_START_TIMEOUT_MS } from "@/screens/SimScreen";
import type { SimGlobeViewProps } from "@/components/SimGlobeView";
import { useSimStore } from "@/state/simStore";
import { useMapFocusStore } from "@/state/mapFocusStore";
import { aircraft, resetStores, seedAircraft } from "./fixtures";

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

  it("leaves on the hardware back button and ends the session", async () => {
    jest.mocked(router.canGoBack).mockReturnValue(true);
    jest.mocked(useLocalSearchParams).mockReturnValue({ kind: "aircraft", id: "abc123" });
    const view = await render(<SimScreen />);
    await tick();

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
