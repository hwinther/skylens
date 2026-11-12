/**
 * usePoseRefs: the live sensor pose for the AR overlay. DeviceMotion and expo-location are the
 * setup.ts mocks; the test captures their listeners and plays sensor events into them. The expected
 * pose comes from the pure orientation pipeline (unit-tested on its own), so these tests pin the
 * hook's plumbing: compass declination, the user's azimuth trim and the screen rotation reach every
 * motion sample, GPS lands in positionRef, and every sensor subscription is released.
 */
import { act, renderHook } from "@testing-library/react-native";
import { DeviceMotion, type DeviceMotionMeasurement } from "expo-sensors";
import * as Location from "expo-location";
import { usePoseRefs, type UsePoseRefsOptions } from "@/components/usePoseRefs";
import { cameraPoseFromRotation } from "@/ar";

const motion = jest.mocked(DeviceMotion);
const location = jest.mocked(Location);

// Phone upright, turned a little to the east of north.
const ROTATION = { alpha: 0.3, beta: Math.PI / 2, gamma: 0 };

function motionListener() {
  const calls = motion.addListener.mock.calls;
  return calls[calls.length - 1][0] as (data: Partial<DeviceMotionMeasurement>) => void;
}

async function renderPose(opts: Partial<UsePoseRefsOptions> = {}) {
  const hook = await renderHook((p: UsePoseRefsOptions) => usePoseRefs(p), {
    // alpha 1: no low-pass, so one sample sets the pose exactly.
    initialProps: { trimDeg: 0, enabled: true, alpha: 1, ...opts },
  });
  await act(async () => {}); // the permission request + subscriptions are async
  return hook;
}

function grantLocation() {
  location.requestForegroundPermissionsAsync.mockResolvedValueOnce({
    status: "granted",
    granted: true,
  } as Awaited<ReturnType<typeof Location.requestForegroundPermissionsAsync>>);
}

describe("usePoseRefs", () => {
  it("subscribes to nothing while disabled (demo mode drives the pose)", async () => {
    await renderPose({ enabled: false });
    expect(motion.addListener).not.toHaveBeenCalled();
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it("applies the compass declination and the azimuth trim to each motion sample", async () => {
    grantLocation();
    const { result, rerender } = await renderPose({ trimDeg: 5 });

    await act(async () => motionListener()({ rotation: { ...ROTATION, timestamp: 0 } }));
    expect(result.current.poseRef.current.azimuth).toBeCloseTo(cameraPoseFromRotation(ROTATION, 0, 5).azimuth);

    // The compass reports true vs magnetic heading: declination = true − magnetic.
    const onHeading = location.watchHeadingAsync.mock.calls[0][0];
    await act(async () => onHeading({ trueHeading: 13, magHeading: 10, accuracy: 3 }));
    await act(async () => motionListener()({ rotation: { ...ROTATION, timestamp: 1 } }));
    expect(result.current.poseRef.current.azimuth).toBeCloseTo(cameraPoseFromRotation(ROTATION, 3, 5).azimuth);
    expect(result.current.headingAccuracyRef.current).toBe(3);

    // A new trim applies to the next sample without re-subscribing the sensors.
    await rerender({ trimDeg: -4, enabled: true, alpha: 1 });
    await act(async () => motionListener()({ rotation: { ...ROTATION, timestamp: 2 } }));
    expect(result.current.poseRef.current.azimuth).toBeCloseTo(cameraPoseFromRotation(ROTATION, 3, -4).azimuth);
    expect(motion.addListener).toHaveBeenCalledTimes(1);
  });

  it("compensates the screen rotation in landscape", async () => {
    const { result } = await renderPose();

    await act(async () => motionListener()({ rotation: { ...ROTATION, timestamp: 0 }, orientation: 90 }));

    const expected = cameraPoseFromRotation(ROTATION, 0, 0, -90);
    const wrap = (deg: number) => ((deg % 360) + 360) % 360;
    expect(wrap(result.current.poseRef.current.roll)).toBeCloseTo(wrap(expected.roll));
    // Negated, not passed through: the opposite rotation would read 180° off.
    expect(wrap(expected.roll)).not.toBeCloseTo(wrap(cameraPoseFromRotation(ROTATION, 0, 0, 90).roll));
    expect(result.current.poseRef.current.elevation).toBeCloseTo(expected.elevation);
  });

  it("puts the GPS fix and its accuracy in the refs", async () => {
    grantLocation();
    const { result } = await renderPose();
    expect(result.current.positionRef.current).toBeNull();

    const onFix = location.watchPositionAsync.mock.calls[0][1];
    await act(async () =>
      onFix({
        coords: { latitude: 59.91, longitude: 10.76, altitude: 42, accuracy: 8 },
        timestamp: 0,
      } as Location.LocationObject),
    );

    expect(result.current.positionRef.current).toEqual({ lat: 59.91, lon: 10.76, alt: 42 });
    expect(result.current.gpsAccuracyRef.current).toBe(8);
  });

  it("still tracks orientation when location is denied, without a GPS or compass watch", async () => {
    await renderPose();
    expect(motion.addListener).toHaveBeenCalledTimes(1);
    expect(location.watchPositionAsync).not.toHaveBeenCalled();
    expect(location.watchHeadingAsync).not.toHaveBeenCalled();
  });

  it("releases every sensor subscription on unmount", async () => {
    grantLocation();
    const motionSub = { remove: jest.fn() };
    const positionSub = { remove: jest.fn() };
    const headingSub = { remove: jest.fn() };
    motion.addListener.mockReturnValueOnce(motionSub as unknown as ReturnType<typeof DeviceMotion.addListener>);
    location.watchPositionAsync.mockResolvedValueOnce(positionSub);
    location.watchHeadingAsync.mockResolvedValueOnce(headingSub);
    const { unmount } = await renderPose();

    await unmount();

    expect(motionSub.remove).toHaveBeenCalled();
    expect(positionSub.remove).toHaveBeenCalled();
    expect(headingSub.remove).toHaveBeenCalled();
  });
});
