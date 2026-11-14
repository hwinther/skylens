/**
 * The tiltable Radar: the tilt control (gesture-handler Pan + Tap, plus accessibility actions), the lazy
 * terrain fetch (nothing until the first tilt, gated like every API caller), the bundled demo relief,
 * and the blips staying tappable while tilted. Rendered directly (AircraftRadar) with a stub API client;
 * the Map screen wiring is covered by MapScreen.native.test.tsx.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { createGestureController, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import type { ApiClient } from "@/api/client";
import { AircraftRadar } from "@/components/AircraftRadar";
import { TILT_DEG_PER_PX, TILT_PAN_GESTURE_ID, TILT_TAP_GESTURE_ID } from "@/components/RadarTiltControl";
import { clearRadarTerrainCache } from "@/components/useRadarTerrain";
import { useAuthStore } from "@/state/authStore";
import demoTerrain from "@/mock/demo-terrain.json";
import { aircraft, resetStores } from "./fixtures";

const OBSERVER = { lat: 59.9, lon: 10.75 };
const PLANE = aircraft("abc123", { lat: 60.0, lon: 10.9 });

function stubClient() {
  const terrain = jest.fn(async () => ({ ...demoTerrain, fetchedAt: new Date(0).toISOString() }));
  return { client: { terrain } as unknown as ApiClient, terrain };
}

async function renderRadar(props: Partial<Parameters<typeof AircraftRadar>[0]> = {}) {
  const onSelect = jest.fn();
  const onTiltChange = jest.fn();
  const utils = await render(
    <GestureHandlerRootView>
      <AircraftRadar
        aircraft={[PLANE]}
        observer={OBSERVER}
        onSelect={onSelect}
        rangeKm={50}
        onRangeChange={jest.fn()}
        tiltDeg={0}
        onTiltChange={onTiltChange}
        {...props}
      />
    </GestureHandlerRootView>,
  );
  // The scope sizes itself from onLayout, which never fires under jest: give it a phone's box.
  await fireEvent(screen.getByTestId("radar"), "layout", {
    nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 640 } },
  });
  return { ...utils, onSelect, onTiltChange };
}

describe("Radar tilt", () => {
  beforeEach(() => {
    resetStores();
    clearRadarTerrainCache();
  });

  it("is flat by default: an adjustable tilt control at 0°, no relief, nothing fetched", async () => {
    const { client, terrain } = stubClient();
    useAuthStore.setState({ authRequired: false });
    await renderRadar({ terrainClient: client });

    const tilt = screen.getByTestId("radar-tilt");
    expect(tilt).toHaveAccessibleName("Radar tilt");
    expect(tilt.props.accessibilityRole).toBe("adjustable");
    expect(tilt.props.accessibilityValue).toMatchObject({ min: 0, max: 60, now: 0 });
    expect(screen.getByTestId("radar-tilt-value")).toHaveTextContent("0°");
    expect(screen.queryByTestId("radar-terrain")).not.toBeOnTheScreen();
    expect(terrain).not.toHaveBeenCalled();
  });

  it("hides the control (and stays flat) when the radar is read-only", async () => {
    await render(
      <GestureHandlerRootView>
        <AircraftRadar aircraft={[PLANE]} observer={OBSERVER} onSelect={jest.fn()} tiltDeg={45} />
      </GestureHandlerRootView>,
    );
    expect(screen.queryByTestId("radar-tilt")).not.toBeOnTheScreen();
  });

  it("a tap toggles flat to 45° and a tilted scope back to flat", async () => {
    const { onTiltChange, rerender } = await renderRadar();
    const tap = createGestureController(getByGestureTestId(TILT_TAP_GESTURE_ID));
    await act(async () => {
      tap.begin();
      tap.activate();
      tap.end();
    });
    expect(onTiltChange).toHaveBeenLastCalledWith(45);

    await rerender(
      <GestureHandlerRootView>
        <AircraftRadar aircraft={[PLANE]} observer={OBSERVER} onSelect={jest.fn()} tiltDeg={45} onTiltChange={onTiltChange} />
      </GestureHandlerRootView>,
    );
    await act(async () => {
      tap.begin();
      tap.activate();
      tap.end();
    });
    expect(onTiltChange).toHaveBeenLastCalledWith(0);
  });

  it("dragging up tilts by the distance moved and commits once, on release", async () => {
    const { onTiltChange } = await renderRadar();
    const pan = createGestureController(getByGestureTestId(TILT_PAN_GESTURE_ID));
    const dy = -Math.round(30 / TILT_DEG_PER_PX);
    await act(async () => {
      pan.begin({ translationY: 0 });
      pan.activate({ translationY: 0 });
      pan.update({ translationY: dy / 2 });
      pan.update({ translationY: dy });
      pan.end({ translationY: dy });
    });
    expect(onTiltChange).toHaveBeenCalledTimes(1);
    expect(onTiltChange.mock.calls[0][0]).toBeCloseTo(30, -1);
  });

  it("steps by 15° with the accessibility increment / decrement actions", async () => {
    const { onTiltChange } = await renderRadar({ tiltDeg: 30 });
    const tilt = screen.getByTestId("radar-tilt");
    await fireEvent(tilt, "accessibilityAction", { nativeEvent: { actionName: "increment" } });
    expect(onTiltChange).toHaveBeenLastCalledWith(45);
    await fireEvent(tilt, "accessibilityAction", { nativeEvent: { actionName: "decrement" } });
    expect(onTiltChange).toHaveBeenLastCalledWith(15);
  });

  it("demo mode: tilted, it draws the bundled relief with its credit, and blips stay tappable", async () => {
    const { client, terrain } = stubClient();
    const { onSelect } = await renderRadar({ tiltDeg: 45, demoMode: true, terrainClient: client });

    expect(screen.getByTestId("radar-terrain")).toBeOnTheScreen();
    expect(screen.getByTestId("radar-terrain-attribution")).toHaveTextContent(/ETOPO 2022 \(NOAA NCEI\).*demo sample/);
    expect(terrain).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId("map-ac-abc123"));
    expect(onSelect).toHaveBeenCalledWith("abc123");
  });

  it("live mode: fetches the grid once tilted, sized to the range, and draws it", async () => {
    const { client, terrain } = stubClient();
    useAuthStore.setState({ authRequired: false });
    await renderRadar({ tiltDeg: 30, terrainClient: client });

    await act(async () => {});
    expect(terrain).toHaveBeenCalledTimes(1);
    expect(terrain).toHaveBeenCalledWith(59.9, 10.75, 75);
    expect(await screen.findByTestId("radar-terrain")).toBeOnTheScreen();
    expect(screen.getByTestId("radar-terrain-attribution")).not.toHaveTextContent(/demo/);
  });

  it("live mode: signed out behind auth, nothing is fetched even when tilted", async () => {
    const { client, terrain } = stubClient();
    useAuthStore.setState({ authRequired: true });
    await renderRadar({ tiltDeg: 30, terrainClient: client });
    await act(async () => {});
    expect(terrain).not.toHaveBeenCalled();
    expect(screen.queryByTestId("radar-terrain")).not.toBeOnTheScreen();
  });
});
