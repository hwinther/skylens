/**
 * Polaris calibration: point the crosshair at the North Star, Confirm, and the azimuth trim is solved
 * from where the (trimmed) sensor pose says it is pointing. A pose whose elevation is far from
 * Polaris's is not applied silently. The clock is fixed so Polaris's position is known.
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import { PolarisCalibrate } from "@/components/PolarisCalibrate";
import { polarisAltAz, type CameraPose } from "@/ar";

const OBSERVER = { lat: 59.9, lon: 10.75 };
const NOW = new Date("2026-01-15T21:00:00Z");

describe("PolarisCalibrate", () => {
  let polaris: { azimuthDeg: number; elevationDeg: number };
  const onApplyTrim = jest.fn();
  const onClose = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    polaris = polarisAltAz(OBSERVER, NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  async function renderAt(pose: CameraPose, opts: { trim?: number; sensorLive?: boolean; observer?: typeof OBSERVER | null } = {}) {
    await render(
      <PolarisCalibrate
        poseRef={{ current: pose }}
        observer={opts.observer === undefined ? OBSERVER : opts.observer}
        currentTrimDeg={opts.trim ?? 0}
        sensorLive={opts.sensorLive ?? true}
        onApplyTrim={onApplyTrim}
        onClose={onClose}
      />,
    );
  }

  it("solves the trim that makes the pose point at Polaris, taking the current trim into account", async () => {
    // The pose (with a 2° trim already applied) reads 6° east of Polaris: the raw compass is 4° off,
    // so the new trim is −4°, not −6° or −8°.
    await renderAt({ azimuth: polaris.azimuthDeg + 6, elevation: polaris.elevationDeg, roll: 0 }, { trim: 2 });

    await fireEvent.press(screen.getByTestId("polaris-confirm"));

    expect(onApplyTrim).toHaveBeenCalledTimes(1);
    expect(onApplyTrim.mock.calls[0][0]).toBeCloseTo(-4, 1);
    expect(onClose).toHaveBeenCalled();
  });

  it("warns instead of applying when the aim is far from Polaris's elevation", async () => {
    await renderAt({ azimuth: polaris.azimuthDeg + 6, elevation: polaris.elevationDeg - 25, roll: 0 });

    await fireEvent.press(screen.getByTestId("polaris-confirm"));
    expect(onApplyTrim).not.toHaveBeenCalled();
    expect(screen.getByText(/doesn't look like Polaris/)).toBeOnTheScreen();

    // "Aim again" goes back to aiming; "Apply anyway" applies the solved trim.
    await fireEvent.press(screen.getByText("Aim again"));
    expect(screen.getByTestId("polaris-confirm")).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId("polaris-confirm"));
    await fireEvent.press(screen.getByTestId("polaris-apply-anyway"));
    expect(onApplyTrim.mock.calls[0][0]).toBeCloseTo(-6, 1);
    expect(onClose).toHaveBeenCalled();
  });

  it("offers no Confirm without a live sensor pose or a position", async () => {
    await renderAt({ azimuth: 0, elevation: 60, roll: 0 }, { sensorLive: false });
    expect(screen.queryByTestId("polaris-confirm")).not.toBeOnTheScreen();
    expect(screen.getByText(/needs the device compass/)).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("polaris-cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(onApplyTrim).not.toHaveBeenCalled();
  });

  it("waits for a position before calibrating", async () => {
    await renderAt({ azimuth: 0, elevation: 60, roll: 0 }, { observer: null });
    expect(screen.queryByTestId("polaris-confirm")).not.toBeOnTheScreen();
    expect(screen.getByText(/Acquiring position/)).toBeOnTheScreen();
  });
});
