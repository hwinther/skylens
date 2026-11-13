/**
 * The AR screen (app/index.tsx) with its overlay (ArOverlay). Camera and sensors are the setup.ts
 * mocks: no camera permission, DeviceMotion never fires, so the live pose stays at its initial
 * value (looking due north at the horizon). The overlay's projection loop runs on
 * requestAnimationFrame, so the tests use fake timers and step frames explicitly.
 *
 * What a user depends on: an aircraft in front of the camera gets a tappable label, one behind gets
 * only an edge arrow; tapping a label opens that aircraft's card; an aircraft that leaves the feed
 * leaves the sky; demo mode replays traffic and drops it again when leaving demo; live mode without
 * a camera or a position says so.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { router } from "expo-router";
import { useCameraPermissions } from "expo-camera";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import ArScreen from "../../app/index";
import * as mockFeed from "@/mock/mockFeed";
import { useAircraftStore } from "@/state/aircraftStore";
import { useObserverStore } from "@/state/observerStore";
import { useSettingsStore } from "@/state/settingsStore";
import { aircraft, resetStores, seedAircraft } from "./fixtures";

const OBSERVER = { lat: 59.9, lon: 10.75 };
// ~11 km due north and due south of the observer, 12 000 ft up.
const NORTH = aircraft("north1", { flight: "NOR1", lat: 60.0, lon: 10.75, alt: 12000 });
const SOUTH = aircraft("south1", { flight: "SOU1", lat: 59.8, lon: 10.75, alt: 12000 });

/** Run the overlay's rAF loop for a few (20 fps-throttled) frames. */
async function frames(ms = 200) {
  await act(async () => jest.advanceTimersByTime(ms));
}

/** The root layout provides the gesture root the demo drag-to-look needs. */
async function renderAr() {
  await render(
    <GestureHandlerRootView>
      <ArScreen />
    </GestureHandlerRootView>,
  );
}

function liveWithPosition() {
  useSettingsStore.setState({ demoMode: false });
  useObserverStore.setState({ position: OBSERVER });
}

describe("ArScreen", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetStores();
    useObserverStore.setState({ position: null });
    useSettingsStore.setState({ hFovDeg: 66, azimuthTrimDeg: 0, polarisCalibrating: false });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("labels the aircraft in front of the camera and points at the one behind", async () => {
    liveWithPosition();
    seedAircraft([NORTH, SOUTH]);
    await renderAr();
    await frames();

    expect(screen.getByTestId("ac-label-north1")).toHaveTextContent(/NOR1/);
    expect(screen.queryByTestId("ac-arrow-north1")).not.toBeOnTheScreen();
    expect(screen.queryByTestId("ac-label-south1")).not.toBeOnTheScreen();
    expect(screen.getByTestId("ac-arrow-south1")).toBeOnTheScreen();
    expect(screen.getByTestId("status-aircraft-count")).toHaveTextContent(/2/);
  });

  it("opens the aircraft's card from its label", async () => {
    liveWithPosition();
    seedAircraft([NORTH]);
    await renderAr();
    await frames();
    expect(screen.queryByTestId("detail-card")).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("ac-label-north1"));

    expect(within(screen.getByTestId("detail-card")).getByText("NOR1")).toBeOnTheScreen();
  });

  it("opens the card on a tap but not when the press turns into a drag-to-look", async () => {
    liveWithPosition();
    seedAircraft([NORTH]);
    await renderAr();
    await frames();
    const label = screen.getByTestId("ac-label-north1");
    const at = (pageX: number, pageY: number) => ({ nativeEvent: { pageX, pageY } });

    // Pressed on the label, dragged 60 px to turn the view, released (still over the label: it moves
    // with the view). That was a drag, not a tap.
    await fireEvent(label, "pressIn", at(100, 200));
    await fireEvent(label, "press", at(160, 200));
    expect(screen.queryByTestId("detail-card")).not.toBeOnTheScreen();

    // A tap that wobbles a few px is still a tap.
    await fireEvent(label, "pressIn", at(100, 200));
    await fireEvent(label, "press", at(104, 203));
    expect(within(screen.getByTestId("detail-card")).getByText("NOR1")).toBeOnTheScreen();
  });

  it("drops a label when its aircraft leaves the feed", async () => {
    liveWithPosition();
    seedAircraft([NORTH]);
    await renderAr();
    await frames();
    expect(screen.getByTestId("ac-label-north1")).toBeOnTheScreen();

    await act(async () => seedAircraft([]));
    await frames();

    expect(screen.queryByTestId("ac-label-north1")).not.toBeOnTheScreen();
  });

  it("narrows what is in frame with the horizontal FOV setting", async () => {
    // ~28° east of north: inside a 66° view (±33°), outside a 40° one (±20°).
    const offAxis = aircraft("offax1", { flight: "OFF1", lat: 60.0, lon: 10.856, alt: 12000 });
    liveWithPosition();
    seedAircraft([offAxis]);
    await renderAr();
    await frames();
    expect(screen.getByTestId("ac-label-offax1")).toBeOnTheScreen();

    await act(async () => useSettingsStore.setState({ hFovDeg: 40 }));
    await frames();

    expect(screen.queryByTestId("ac-label-offax1")).not.toBeOnTheScreen();
    expect(screen.getByTestId("ac-arrow-offax1")).toBeOnTheScreen();
  });

  it("shows the synthetic horizon with compass hints when there is no camera", async () => {
    liveWithPosition();
    await renderAr();
    await frames();

    expect(screen.getByTestId("ar-horizon")).toBeOnTheScreen();
    // Looking north: N is in view, S (behind) is not.
    expect(screen.getByTestId("compass-N")).toBeOnTheScreen();
    expect(screen.queryByTestId("compass-S")).not.toBeOnTheScreen();
  });

  it("says it is acquiring a position in live mode until the first fix", async () => {
    useSettingsStore.setState({ demoMode: false });
    await renderAr();
    expect(screen.getByText("Acquiring position…")).toBeOnTheScreen();

    await act(async () => useObserverStore.setState({ position: OBSERVER }));
    expect(screen.queryByText("Acquiring position…")).not.toBeOnTheScreen();
  });

  it("explains a denied camera and leads to Settings", async () => {
    liveWithPosition();
    jest
      .mocked(useCameraPermissions)
      .mockReturnValue([
        { granted: false, canAskAgain: false, status: "denied", expires: "never" },
        jest.fn(() => Promise.resolve({ granted: false })),
        jest.fn(),
      ] as unknown as ReturnType<typeof useCameraPermissions>);
    await renderAr();

    await fireEvent.press(screen.getByText(/Camera off/));
    expect(router.push).toHaveBeenCalledWith("/settings");
  });

  it("asks for the camera when going live without permission", async () => {
    const request = jest.fn(() => Promise.resolve({ granted: true }));
    jest
      .mocked(useCameraPermissions)
      .mockReturnValue([
        { granted: false, canAskAgain: true, status: "undetermined", expires: "never" },
        request,
        jest.fn(),
      ] as unknown as ReturnType<typeof useCameraPermissions>);
    liveWithPosition();
    await renderAr();
    expect(request).toHaveBeenCalled();
  });

  it("demo mode replays recorded traffic and drops it on leaving demo", async () => {
    await renderAr();
    await frames(3_000);

    const state = useAircraftStore.getState();
    expect(state.source).toBe("demo");
    expect(state.connection).toBe("connected");
    expect(Object.keys(state.byHex).length).toBeGreaterThan(0);
    // The replay puts traffic in front of the demo pose (looking east from the demo home).
    expect(screen.getAllByTestId(/^ac-(label|arrow)-/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Acquiring position…")).not.toBeOnTheScreen();

    await act(async () => useSettingsStore.setState({ demoMode: false }));

    expect(useAircraftStore.getState().byHex).toEqual({});
    expect(useAircraftStore.getState().source).toBe("live");
  });

  it("demo mode's sky image is sized to fill the screen, not to the asset's intrinsic size", async () => {
    // On Android, Image places the static asset's own size (sky.png: 64x256) ahead of the style as
    // width/height, and that beats left/right/top/bottom stretching; only an explicit size wins.
    await renderAr();
    const sky = StyleSheet.flatten(screen.getByTestId("ar-demo-sky").props.style);
    expect(sky).toMatchObject({ position: "absolute", width: "100%", height: "100%" });
  });

  it("demo mode looks through the drag pose (east, 20° up), not the live sensor pose", async () => {
    // From the demo home (59.9, 10.75): one ~11 km east and ~20° up, one ~11 km north at the same height.
    const east = aircraft("east01", { flight: "EAST1", lat: 59.9, lon: 10.9475, alt: 13100 });
    const north = aircraft("north2", { flight: "NOR2", lat: 60.0, lon: 10.75, alt: 13100 });
    jest.spyOn(mockFeed, "startMockFeed").mockImplementation(({ onSnapshot }) => {
      onSnapshot([east, north]);
      return { stop: () => {} };
    });
    await renderAr();
    await frames();

    expect(screen.getByTestId("ac-label-east01")).toBeOnTheScreen();
    expect(screen.queryByTestId("ac-label-north2")).not.toBeOnTheScreen();
    expect(screen.getByTestId("ac-arrow-north2")).toBeOnTheScreen();
  });

  it("opens the trust legend from the status strip and closes it on the backdrop", async () => {
    await renderAr();
    await fireEvent.press(screen.getByTestId("status-info"));
    expect(screen.getByTestId("legend-backdrop")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("legend-backdrop"));
    expect(screen.queryByTestId("legend-backdrop")).not.toBeOnTheScreen();
  });
});
