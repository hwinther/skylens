/**
 * "Signal lost" in the AR view: an aircraft (or moving ship) with no new position for longer than its
 * kind's limit (src/ar/signalLost) keeps its label at the last known direction, but marked: a hollow
 * anchor (testID ar-ac-lost-<hex> / ar-ves-lost-<mmsi>), a "lost · 31 s" second line, an accessible
 * label that says "signal lost", a hollow edge arrow, and a status line on its detail card. A new
 * position brings it back to normal.
 *
 * Fixed pose: looking due north at the horizon from (59.9, 10.75). The projection loop runs on
 * requestAnimationFrame, so time and frames are stepped with fake timers.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import ArScreen from "../../app/index";
import { ArOverlay, type ArOverlayProps } from "@/components/ArOverlay";
import type { CameraPose, GeoPoint } from "@/ar";
import { AIRCRAFT_STALE_AFTER_S, VESSEL_MOVING_STALE_AFTER_S } from "@/ar/positionTracker";
import type { AircraftDto, VesselDto } from "@/api/types";
import { useObserverStore } from "@/state/observerStore";
import { useSettingsStore } from "@/state/settingsStore";
import { aircraft, resetStores, seedAircraft } from "./fixtures";

const pose: { current: CameraPose } = { current: { azimuth: 0, elevation: 0, roll: 0 } };
const position: { current: GeoPoint | null } = { current: { lat: 59.9, lon: 10.75, alt: 0 } };

// ~11 km north (in view) and south (behind: edge arrow only), slow enough to stay put while dead-reckoned.
const NORTH = aircraft("north1", { flight: "NOR1", lat: 60.0, lon: 10.75, alt: 12000, fl: 120, gs: 60, trk: 90 });
const SOUTH = aircraft("south1", { flight: "SOU1", lat: 59.8, lon: 10.75, alt: 12000, gs: 60, trk: 90 });
const SHIP = { mmsi: "257000001", kind: "ship", name: "NORDLYS", lat: 59.945, lon: 10.75, sog: 8, cog: 90 } as VesselDto;

function props(over: Partial<ArOverlayProps> = {}): ArOverlayProps {
  return {
    aircraft: [],
    snapshotAt: Date.now(),
    poseRef: pose,
    positionRef: position,
    hFovDeg: 66,
    onSelect: jest.fn(),
    ...over,
  };
}

/** Let `ms` pass with the overlay's rAF loop running. */
async function elapse(ms = 200) {
  await act(async () => jest.advanceTimersByTime(ms));
}

describe("ArOverlay signal lost", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("marks an aircraft lost after its limit without a new position, and restores it on an update", async () => {
    const onSignalLost = jest.fn();
    const view = await render(<ArOverlay {...props({ aircraft: [NORTH], onSignalLost })} />);
    await elapse();

    // Fresh: the normal label (flight level line), no lost marker.
    expect(screen.getByTestId("ac-label-north1")).toHaveTextContent(/FL120/);
    expect(screen.queryByTestId("ar-ac-lost-north1")).not.toBeOnTheScreen();
    expect(screen.queryByLabelText(/signal lost/i)).not.toBeOnTheScreen();

    // Dead-reckoning but still within the limit: unchanged.
    await elapse((AIRCRAFT_STALE_AFTER_S - 1) * 1000);
    expect(screen.queryByTestId("ar-ac-lost-north1")).not.toBeOnTheScreen();
    expect(onSignalLost).not.toHaveBeenCalledWith({ aircraft: ["north1"], vessels: [] });

    // Past the limit: still drawn at its last direction, but marked.
    await elapse(2000);
    expect(screen.getByTestId("ar-ac-lost-north1")).toBeOnTheScreen();
    const label = screen.getByTestId("ac-label-north1");
    expect(label).toHaveTextContent(/NOR1/);
    expect(label).toHaveTextContent(/lost · 3\d s/);
    expect(label).not.toHaveTextContent(/FL120/);
    expect(screen.getByLabelText(/NOR1, signal lost 3\d s ago/)).toBe(label);
    expect(onSignalLost).toHaveBeenLastCalledWith({ aircraft: ["north1"], vessels: [] });

    // A fresh position arrives: back to normal.
    await view.rerender(
      <ArOverlay {...props({ aircraft: [{ ...NORTH, lat: 60.001 }], snapshotAt: Date.now(), onSignalLost })} />,
    );
    await elapse();
    expect(screen.queryByTestId("ar-ac-lost-north1")).not.toBeOnTheScreen();
    expect(screen.getByTestId("ac-label-north1")).toHaveTextContent(/FL120/);
    expect(onSignalLost).toHaveBeenLastCalledWith({ aircraft: [], vessels: [] });
  });

  it("dims the edge arrow of a lost aircraft behind the camera", async () => {
    const view = await render(<ArOverlay {...props({ aircraft: [SOUTH] })} />);
    await elapse();
    expect(screen.getByTestId("ac-arrow-south1")).toBeOnTheScreen();
    expect(screen.queryByTestId("ar-ac-arrow-lost-south1")).not.toBeOnTheScreen();

    await elapse((AIRCRAFT_STALE_AFTER_S + 1) * 1000);
    expect(screen.getByTestId("ac-arrow-south1")).toBeOnTheScreen(); // kept, not removed
    expect(screen.getByTestId("ar-ac-arrow-lost-south1")).toBeOnTheScreen();

    const fresh: AircraftDto = { ...SOUTH, lat: 59.801 };
    await view.rerender(<ArOverlay {...props({ aircraft: [fresh], snapshotAt: Date.now() })} />);
    await elapse();
    expect(screen.queryByTestId("ar-ac-arrow-lost-south1")).not.toBeOnTheScreen();
  });

  it("marks a moving ship lost after the vessel limit", async () => {
    const onSignalLost = jest.fn();
    const shipProps = { vessels: [SHIP], vesselsSnapshotAt: Date.now(), showShips: true, onSelectVessel: jest.fn(), onSignalLost };
    const view = await render(<ArOverlay {...props(shipProps)} />);
    await elapse();
    expect(screen.getByTestId("ves-label-257000001")).toHaveTextContent(/NORDLYS/);
    expect(screen.queryByTestId("ar-ves-lost-257000001")).not.toBeOnTheScreen();

    await elapse((VESSEL_MOVING_STALE_AFTER_S + 1) * 1000);
    expect(screen.getByTestId("ar-ves-lost-257000001")).toBeOnTheScreen();
    expect(screen.getByTestId("ves-label-257000001")).toHaveTextContent(/lost · 2 min/);
    expect(screen.getByLabelText("Open details for NORDLYS, signal lost 2 min ago")).toBeOnTheScreen();
    expect(onSignalLost).toHaveBeenLastCalledWith({ aircraft: [], vessels: ["257000001"] });

    await view.rerender(
      <ArOverlay {...props({ ...shipProps, vessels: [{ ...SHIP, lat: 59.946 }], vesselsSnapshotAt: Date.now() })} />,
    );
    await elapse();
    expect(screen.queryByTestId("ar-ves-lost-257000001")).not.toBeOnTheScreen();
  });
});

describe("ArScreen signal lost", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetStores();
    useSettingsStore.setState({ demoMode: false, hFovDeg: 66, azimuthTrimDeg: 0, polarisCalibrating: false });
    useObserverStore.setState({ position: { lat: 59.9, lon: 10.75 } });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("says so on the detail card of a lost aircraft until a fresh position arrives", async () => {
    seedAircraft([NORTH]);
    await render(
      <GestureHandlerRootView>
        <ArScreen />
      </GestureHandlerRootView>,
    );
    await elapse();
    await fireEvent.press(screen.getByTestId("ac-label-north1"));
    const card = () => screen.getByTestId("detail-card");
    expect(within(card()).queryByText(/Signal lost/)).not.toBeOnTheScreen();

    await elapse((AIRCRAFT_STALE_AFTER_S + 1) * 1000);
    // Collapsed compact card: the summary leads with it.
    expect(within(card()).getByText(/^Signal lost/)).toBeOnTheScreen();

    await act(async () => seedAircraft([{ ...NORTH, lat: 60.001 }]));
    await elapse();
    expect(within(card()).queryByText(/Signal lost/)).not.toBeOnTheScreen();
  });
});
