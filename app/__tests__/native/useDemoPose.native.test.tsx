/**
 * useDemoPose: drag-to-look for demo mode (and web without sensors). The pan gesture is attached to a
 * view as the AR screen does and driven with gesture-handler's own jest utilities; the pose ref is
 * what the AR overlay reads every frame.
 */
import { View } from "react-native";
import { act, render } from "@testing-library/react-native";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { createGestureController } from "react-native-gesture-handler/jest-utils";
import { useDemoPose, type UseDemoPoseOptions, type UseDemoPoseResult } from "@/components/useDemoPose";

/** Mount the hook with its gesture on a view; returns a getter for the hook's latest result. */
async function renderDemoPose(options: UseDemoPoseOptions) {
  const out: { current: UseDemoPoseResult | null } = { current: null };
  function Probe() {
    const result = useDemoPose(options);
    out.current = result;
    return (
      <GestureDetector gesture={result.gesture}>
        <View />
      </GestureDetector>
    );
  }
  await render(
    <GestureHandlerRootView>
      <Probe />
    </GestureHandlerRootView>,
  );
  return () => out.current!;
}

async function drag(demo: UseDemoPoseResult, dx: number, dy: number) {
  const pan = createGestureController(demo.gesture);
  await act(async () => {
    pan.begin();
    pan.activate();
    pan.update({ translationX: dx, translationY: dy });
    pan.end({ translationX: dx, translationY: dy });
  });
}

describe("useDemoPose", () => {
  it("starts at the given azimuth, 20° above the horizon", async () => {
    const demo = await renderDemoPose({ initialAzimuth: 90 });
    expect(demo().poseRef.current).toEqual({ azimuth: 90, elevation: 20, roll: 0 });
  });

  it("turns with a horizontal drag and tilts with a vertical one, from where the last drag ended", async () => {
    const demo = await renderDemoPose({ initialAzimuth: 90, degPerPx: 0.1 });

    // Drag right 100 px and up 50 px: look 10° further right and 5° higher.
    await drag(demo(), 100, -50);
    expect(demo().poseRef.current).toEqual({ azimuth: 100, elevation: 25, roll: 0 });

    // The next drag continues from there; turning past north wraps the azimuth.
    await drag(demo(), -1100, 0);
    expect(demo().poseRef.current.azimuth).toBeCloseTo(350);
    expect(demo().poseRef.current.elevation).toBe(25);
  });

  it("can't tilt past straight up or far below the horizon", async () => {
    const demo = await renderDemoPose({ degPerPx: 1 });

    await drag(demo(), 0, -500);
    expect(demo().poseRef.current.elevation).toBe(90);

    await drag(demo(), 0, 500);
    expect(demo().poseRef.current.elevation).toBe(-20);
  });
});
