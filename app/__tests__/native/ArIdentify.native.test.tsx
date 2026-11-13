/**
 * AR identify on the AR screen (app/index.tsx + components/ArIdentify): long-press a point → laser beam
 * + result card naming the landmark; the viewfinder toggle → reticle + continuous identification of the
 * view's centre. Pose: the live pose stays at the setup.ts mock's initial value (due north, level), the
 * demo pose starts east and 20° up (useDemoPose). The overlay and identify layer run on
 * requestAnimationFrame, so the tests use fake timers and step frames.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { Dimensions } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { createGestureController, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { LONG_PRESS_GESTURE_ID } from "@/components/ArIdentify";
import ArScreen from "../../app/index";
import {
  effectiveHFovDeg,
  FINGER_TOLERANCE_DEG,
  identifyLandmark,
  prepareLandmarks,
  project,
  screenToNdc,
  unproject,
  type Landmark,
} from "@/ar";
import { useAuthStore } from "@/state/authStore";
import { useObserverStore } from "@/state/observerStore";
import { useSettingsStore } from "@/state/settingsStore";
import demoLandmarks from "@/mock/demo-landmarks.json";
import { aircraft, backendJson, resetStores, routeFetch, seedAircraft } from "./fixtures";

const OBSERVER = { lat: 59.9, lon: 10.75 };
// A peak ~20 km due north of OBSERVER, 800 m high: from sea level its upper flank spans ~1.1°–2.2° up,
// within the reticle's cone of the level, north-facing live pose.
const NORTH_PEAK: Landmark = {
  id: "g1",
  kind: "peak",
  name: "Nordtoppen",
  lat: 60.08,
  lon: 10.75,
  elevationM: 800,
  population: null,
  isolationKm: 25,
};
const EAST_TOWN: Landmark = { id: "g2", kind: "town", name: "Østby", lat: 59.9, lon: 11.1, population: 5000 };

async function frames(ms = 300) {
  await act(async () => jest.advanceTimersByTime(ms));
}

async function renderAr() {
  await render(
    <GestureHandlerRootView>
      <ArScreen />
    </GestureHandlerRootView>,
  );
}

function config() {
  const { width, height } = Dimensions.get("window");
  return { width, height, cfg: { hFovDeg: effectiveHFovDeg(66, width / height), aspect: width / height, cullMargin: 0.15 } };
}

/** Pixel where look-angles land for a pose (the overlay's mapping). */
function pixelOf(azimuth: number, elevation: number, pose: { azimuth: number; elevation: number; roll: number }) {
  const { width, height, cfg } = config();
  const p = project({ azimuth, elevation }, pose, cfg);
  return { x: (p.xNdc * width) / 2 + width / 2, y: height / 2 - (p.yNdc * height) / 2 };
}

/** A held, unmoving press at (x, y), driven through gesture-handler's own jest utilities. */
async function longPressAt(x: number, y: number) {
  expect(screen.getByTestId("ar-identify-touch")).toBeOnTheScreen();
  const press = createGestureController(getByGestureTestId(LONG_PRESS_GESTURE_ID));
  await act(async () => {
    press.begin({ x, y });
    press.activate({ x, y });
    press.end({ x, y });
  });
}

function liveWithLandmarks(landmarks: Landmark[]) {
  useSettingsStore.setState({ demoMode: false });
  useObserverStore.setState({ position: OBSERVER });
  useAuthStore.setState({ authRequired: false });
  return routeFetch({
    "/api/landmarks": () =>
      backendJson({ fetchedAt: new Date(0).toISOString(), landmarks, attribution: "GeoNames (CC BY 4.0)" }),
  });
}

describe("AR identify", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetStores();
    useObserverStore.setState({ position: null });
    useSettingsStore.setState({ hFovDeg: 66, azimuthTrimDeg: 0, polarisCalibrating: false });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("demo mode: a long-press on the horizon names the landmark there from the bundled sample, with a beam", async () => {
    await renderAr();
    await frames();
    expect(screen.queryByTestId("ar-identify-result")).not.toBeOnTheScreen();

    // The demo pose looks east, 20° up. Press on a sample landmark in view, and expect what the pure
    // matcher says for that ray (the screen wiring is under test here, not the scoring).
    const demoPose = { azimuth: 90, elevation: 20, roll: 0 };
    const inView = prepareLandmarks({ lat: 59.9, lon: 10.75, alt: 100 }, demoLandmarks as Landmark[]).find(
      (p) => p.azimuthDeg > 70 && p.azimuthDeg < 110,
    )!;
    const { x, y } = pixelOf(inView.azimuthDeg, (inView.bandLowDeg + inView.bandHighDeg) / 2, demoPose);
    const { width, height, cfg } = config();
    const { xNdc, yNdc } = screenToNdc(x, y, width, height);
    const expected = identifyLandmark(
      { lat: 59.9, lon: 10.75, alt: 100 },
      unproject(xNdc, yNdc, demoPose, cfg),
      demoLandmarks as Landmark[],
      { toleranceDeg: FINGER_TOLERANCE_DEG },
    );
    expect(expected).not.toBeNull();

    await longPressAt(x, y);
    await frames();

    const card = screen.getByTestId("ar-identify-result");
    expect(within(card).getByTestId("ar-identify-name")).toHaveTextContent(expected!.best.landmark.name);
    expect(card).toHaveTextContent(/GeoNames \(CC BY 4\.0\)/);
    expect(card).toHaveTextContent(/demo sample/);
    expect(card.props.accessibilityLabel).toContain(expected!.best.landmark.name);
    await frames();
    expect(screen.getByTestId("ar-identify-beam")).toBeOnTheScreen();
    expect(screen.getByTestId("ar-identify-marker")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("ar-identify-close"));
    expect(screen.queryByTestId("ar-identify-result")).not.toBeOnTheScreen();
    await frames();
    expect(screen.queryByTestId("ar-identify-beam")).not.toBeOnTheScreen();
  });

  it("says when nothing named lies that way (a press high in the sky)", async () => {
    await renderAr();
    const { x, y } = pixelOf(90, 55, { azimuth: 90, elevation: 20, roll: 0 });

    await longPressAt(x, y);
    await frames();

    expect(screen.getByTestId("ar-identify-name")).toHaveTextContent("Nothing named in that direction");
    expect(screen.getByTestId("ar-identify-result").props.accessibilityLabel).toBe(
      "Nothing named in that direction",
    );
  });

  it("live mode fetches the area's landmarks once and identifies a long-pressed peak", async () => {
    const requested = liveWithLandmarks([NORTH_PEAK, EAST_TOWN]);
    await renderAr();
    // Nothing is fetched until identify is used.
    expect(requested).not.toContain("/api/landmarks");

    // Live pose: due north, level. The town is due east — off screen — so press the north peak instead.
    const { x, y } = pixelOf(0, 1.8, { azimuth: 0, elevation: 0, roll: 0 });
    await longPressAt(x, y);
    await frames();

    expect(requested.filter((p) => p === "/api/landmarks")).toHaveLength(1);
    expect(screen.getByTestId("ar-identify-name")).toHaveTextContent("Nordtoppen");
    expect(screen.getByTestId("ar-identify-result")).toHaveTextContent(/Peak · [\d.]+ km · 800 m high/);

    // A second press reuses the fetched set.
    await longPressAt(x, y);
    await frames();
    expect(requested.filter((p) => p === "/api/landmarks")).toHaveLength(1);
  });

  it("a press before the landmarks have arrived says it is looking them up, then names the match", async () => {
    // The first press triggers the lazy fetch: the card must show at once, then update in place.
    let respond!: (r: Response) => void;
    useSettingsStore.setState({ demoMode: false });
    useObserverStore.setState({ position: OBSERVER });
    useAuthStore.setState({ authRequired: false });
    routeFetch({ "/api/landmarks": () => new Promise<Response>((resolve) => (respond = resolve)) });
    await renderAr();

    const { x, y } = pixelOf(0, 1.8, { azimuth: 0, elevation: 0, roll: 0 });
    await longPressAt(x, y);
    await frames();
    expect(screen.getByTestId("ar-identify-name")).toHaveTextContent("Looking up landmarks…");

    await act(async () =>
      respond(
        backendJson({ fetchedAt: new Date(0).toISOString(), landmarks: [NORTH_PEAK], attribution: "GeoNames (CC BY 4.0)" }),
      ),
    );
    await frames();
    expect(screen.getByTestId("ar-identify-name")).toHaveTextContent("Nordtoppen");
    expect(screen.getByTestId("ar-identify-result")).toHaveTextContent(/GeoNames \(CC BY 4\.0\)/);
  });

  it("the viewfinder toggle shows a reticle and names what the centre of the view points at", async () => {
    liveWithLandmarks([NORTH_PEAK]);
    await renderAr();
    const toggle = screen.getByTestId("ar-identify-toggle");
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole("switch")).toBe(toggle);
    expect(screen.queryByTestId("ar-identify-reticle")).not.toBeOnTheScreen();

    await fireEvent.press(toggle);
    await frames(600);

    expect(screen.getByTestId("ar-identify-toggle")).toBeChecked();
    expect(screen.getByTestId("ar-identify-reticle")).toBeOnTheScreen();
    expect(screen.getByTestId("ar-identify-name")).toHaveTextContent("Nordtoppen");
    // The beam follows one frame after the answer.
    await frames();
    expect(screen.getByTestId("ar-identify-beam")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("ar-identify-toggle"));
    expect(screen.queryByTestId("ar-identify-reticle")).not.toBeOnTheScreen();
    expect(screen.queryByTestId("ar-identify-result")).not.toBeOnTheScreen();
  });

  it("steps aside for a detail card: tapping a label drops the long-press result", async () => {
    liveWithLandmarks([NORTH_PEAK]);
    seedAircraft([aircraft("north1", { flight: "NOR1", lat: 60.0, lon: 10.75, alt: 12000 })]);
    await renderAr();
    await frames();

    const { x, y } = pixelOf(0, 1.8, { azimuth: 0, elevation: 0, roll: 0 });
    await longPressAt(x, y);
    await frames();
    expect(screen.getByTestId("ar-identify-result")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("ac-label-north1"));
    await frames();

    expect(screen.getByTestId("detail-card")).toBeOnTheScreen();
    expect(screen.queryByTestId("ar-identify-result")).not.toBeOnTheScreen();
    expect(screen.queryByTestId("ar-identify-beam")).not.toBeOnTheScreen();
  });

  it("live mode signed out behind auth makes no call and says landmarks are unavailable", async () => {
    useSettingsStore.setState({ demoMode: false });
    useObserverStore.setState({ position: OBSERVER });
    const requested = routeFetch({});
    await renderAr();

    const { x, y } = pixelOf(0, 1.8, { azimuth: 0, elevation: 0, roll: 0 });
    await longPressAt(x, y);
    await frames();

    expect(requested).toEqual([]);
    expect(screen.getByTestId("ar-identify-name")).toHaveTextContent("Landmarks unavailable");
  });
});
