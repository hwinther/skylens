/**
 * The AR view's layer filter (components/ArFilter + state/arFilter) on the AR screen: the Layers button
 * unfolds one chip per group that is on in Settings; hiding a group stops the overlay drawing it (labels
 * and edge arrows), badges the button with the hidden count, persists in settingsStore, closes an open
 * card of that group, and "Show all" brings everything back. Live pose: due north, level (setup.ts).
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import ArScreen from "../../app/index";
import { useObserverStore } from "@/state/observerStore";
import { useSettingsStore } from "@/state/settingsStore";
import { useVesselStore } from "@/state/vesselStore";
import { aircraft, resetStores, seedAircraft } from "./fixtures";

const OBSERVER = { lat: 59.9, lon: 10.75 };
const NORTH = aircraft("north1", { flight: "NOR1", lat: 60.0, lon: 10.75, alt: 12000 });
const SOUTH = aircraft("south1", { flight: "SOU1", lat: 59.8, lon: 10.75, alt: 12000 });

async function frames(ms = 200) {
  await act(async () => jest.advanceTimersByTime(ms));
}

async function renderAr() {
  await render(
    <GestureHandlerRootView>
      <ArScreen />
    </GestureHandlerRootView>,
  );
}

function live() {
  useSettingsStore.setState({ demoMode: false });
  useObserverStore.setState({ position: OBSERVER });
}

describe("AR filter", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetStores();
    useObserverStore.setState({ position: null });
    useSettingsStore.setState({ hFovDeg: 66, azimuthTrimDeg: 0, polarisCalibrating: false });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("offers a chip per group that is on in Settings, and nothing is hidden at first", async () => {
    live();
    useSettingsStore.setState({ showShips: true, showAirports: true, showSatellites: false, showPlanets: false });
    await renderAr();

    const button = screen.getByTestId("ar-filter");
    expect(button.props.accessibilityLabel ?? button.props["aria-label"]).toBe("Layers");
    expect(screen.queryByTestId("ar-filter-badge")).not.toBeOnTheScreen();
    expect(screen.queryByTestId("ar-filter-panel")).not.toBeOnTheScreen();

    await fireEvent.press(button);
    const panel = screen.getByTestId("ar-filter-panel");
    expect(within(panel).getByTestId("ar-filter-aircraft")).toHaveTextContent("Aircraft");
    expect(within(panel).getByTestId("ar-filter-vessels")).toHaveTextContent("Vessels");
    expect(within(panel).getByTestId("ar-filter-airports")).toHaveTextContent("Airports");
    // Off in Settings: no chip.
    expect(screen.queryByTestId("ar-filter-satellites")).not.toBeOnTheScreen();
    expect(screen.queryByTestId("ar-filter-sky")).not.toBeOnTheScreen();
    expect(screen.getByTestId("ar-filter-aircraft")).toBeSelected();
    expect(screen.getByTestId("ar-filter-reset")).toBeDisabled();

    await fireEvent.press(screen.getByTestId("ar-filter"));
    expect(screen.queryByTestId("ar-filter-panel")).not.toBeOnTheScreen();
  });

  it("hiding aircraft removes their labels and edge arrows, badges the button, and Show all restores them", async () => {
    live();
    seedAircraft([NORTH, SOUTH]);
    await renderAr();
    await frames();
    expect(screen.getByTestId("ac-label-north1")).toBeOnTheScreen();
    expect(screen.getByTestId("ac-arrow-south1")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("ar-filter"));
    await fireEvent.press(screen.getByTestId("ar-filter-aircraft"));
    await frames();

    expect(screen.queryByTestId("ac-label-north1")).not.toBeOnTheScreen();
    expect(screen.queryByTestId("ac-arrow-south1")).not.toBeOnTheScreen();
    expect(screen.getByTestId("ar-filter-aircraft")).not.toBeSelected();
    expect(screen.getByTestId("ar-filter-badge")).toHaveTextContent("1");
    expect(screen.getByTestId("ar-filter").props["aria-label"] ?? screen.getByTestId("ar-filter").props.accessibilityLabel).toBe(
      "Layers, 1 hidden",
    );
    expect(useSettingsStore.getState().arHiddenGroups).toEqual(["aircraft"]);
    // Only what AR draws: the feed and its count are untouched.
    expect(screen.getByTestId("status-aircraft-count")).toHaveTextContent(/2/);

    await fireEvent.press(screen.getByTestId("ar-filter-reset"));
    await frames();
    expect(screen.getByTestId("ac-label-north1")).toBeOnTheScreen();
    expect(screen.getByTestId("ac-arrow-south1")).toBeOnTheScreen();
    expect(screen.queryByTestId("ar-filter-badge")).not.toBeOnTheScreen();
    expect(useSettingsStore.getState().arHiddenGroups).toEqual([]);
  });

  it("Hide all hides every offered group; other groups keep drawing while one is hidden", async () => {
    live();
    seedAircraft([NORTH]);
    // A ship ~5 km north, in the surface band of the north-facing view.
    useVesselStore.getState().setSnapshot([{ mmsi: "257000001", kind: "ship", name: "NORDLYS", lat: 59.945, lon: 10.75 }]);
    await renderAr();
    await frames();
    expect(screen.getByTestId("ves-label-257000001")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("ar-filter"));
    await fireEvent.press(screen.getByTestId("ar-filter-vessels"));
    await frames();
    expect(screen.queryByTestId("ves-label-257000001")).not.toBeOnTheScreen();
    expect(screen.getByTestId("ac-label-north1")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("ar-filter-hide-all"));
    await frames();
    expect(screen.queryByTestId("ac-label-north1")).not.toBeOnTheScreen();
    expect(screen.getByTestId("ar-filter-badge")).toHaveTextContent("2");
    expect(screen.getByTestId("ar-filter-hide-all")).toBeDisabled();
    expect(useSettingsStore.getState().arHiddenGroups).toEqual(["aircraft", "vessels"]);
  });

  it("hiding the open card's group closes the card", async () => {
    live();
    seedAircraft([NORTH]);
    await renderAr();
    await frames();
    await fireEvent.press(screen.getByTestId("ac-label-north1"));
    expect(screen.getByTestId("detail-card")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("ar-filter"));
    await fireEvent.press(screen.getByTestId("ar-filter-aircraft"));
    await frames();
    expect(screen.queryByTestId("detail-card")).not.toBeOnTheScreen();
  });

  it("a filter saved earlier applies on open", async () => {
    live();
    useSettingsStore.setState({ arHiddenGroups: ["aircraft"] });
    seedAircraft([NORTH]);
    await renderAr();
    await frames();
    expect(screen.queryByTestId("ac-label-north1")).not.toBeOnTheScreen();
    expect(screen.getByTestId("ar-filter-badge")).toHaveTextContent("1");
  });
});
