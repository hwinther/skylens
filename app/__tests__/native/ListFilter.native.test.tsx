/**
 * List tab filter bar + accordion: the chips hide and restore kinds of row (Traffic splits into Air
 * and Sea), counts follow what is shown, section headings collapse/expand, the "everything filtered"
 * empty state offers Show all, and both choices come back after a relaunch (rehydrated store).
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import ListScreen from "../../app/list";
import type { VesselDto } from "@/api/types";
import { useSettingsStore } from "@/state/settingsStore";
import { useVesselStore } from "@/state/vesselStore";
import { aircraft, resetStores, seedAircraft } from "./fixtures";

const SETTINGS_KEY = "skylens.settings.v1";

function vessel(mmsi: string, over: Partial<VesselDto> = {}): VesselDto {
  return { mmsi, kind: "ship", name: `SHIP ${mmsi}`, lat: 59.93, lon: 10.7, sog: 8, cog: 180, ...over };
}

function seedTraffic() {
  seedAircraft([aircraft("abc123", { flight: "SAS123" }), aircraft("def456", { flight: "NAX456", lat: 59.97 })]);
  useVesselStore.getState().setSnapshot([vessel("257000001")]);
}

/** Chip state: `aria-pressed` (what web renders) and `selected` (the native accessibility state). */
function pressed(testID: string): boolean {
  const chip = screen.getByTestId(testID);
  expect(chip.props.accessibilityState?.selected).toBe(chip.props["aria-pressed"]);
  return chip.props["aria-pressed"] as boolean;
}
/** Section heading state, as assistive tech reads it (Pressable maps aria-expanded natively). */
const expanded = (testID: string) => screen.getByTestId(testID).props.accessibilityState?.expanded;

describe("List filter and sections", () => {
  beforeEach(() => {
    resetStores();
  });

  it("shows one chip per available kind with its count, and none for layers that are off", async () => {
    seedTraffic();
    await render(<ListScreen />);

    expect(screen.getByTestId("list-filter-air")).toHaveTextContent("Air2");
    expect(screen.getByTestId("list-filter-sea")).toHaveTextContent("Sea1");
    expect(pressed("list-filter-air")).toBe(true);
    // Satellites, Sky, Radio and Events are switched off in Settings (see resetStores).
    for (const kind of ["satellites", "sky", "radio", "events"]) {
      expect(screen.queryByTestId(`list-filter-${kind}`)).not.toBeOnTheScreen();
    }
  });

  it("hiding Sea removes the ship rows, keeps the aircraft and updates the Traffic count", async () => {
    seedTraffic();
    await render(<ListScreen />);
    expect(screen.getByTestId("list-count")).toHaveTextContent("Traffic (3)");
    expect(within(screen.getByTestId("list-section-traffic")).getByText("2 air · 1 sea")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("list-filter-sea"));
    expect(pressed("list-filter-sea")).toBe(false);
    expect(screen.queryByTestId("list-ship-257000001")).not.toBeOnTheScreen();
    expect(screen.getByTestId("list-ac-abc123")).toBeOnTheScreen();
    expect(screen.getByTestId("list-count")).toHaveTextContent("Traffic (2)");
    expect(within(screen.getByTestId("list-section-traffic")).getByText("2 air")).toBeOnTheScreen();
    // The chip keeps counting what it hides.
    expect(screen.getByTestId("list-filter-sea")).toHaveTextContent("Sea1");

    await fireEvent.press(screen.getByTestId("list-filter-sea"));
    expect(screen.getByTestId("list-ship-257000001")).toBeOnTheScreen();
    expect(screen.getByTestId("list-count")).toHaveTextContent("Traffic (3)");
  });

  it("says which family is empty when only the hidden one has traffic", async () => {
    useVesselStore.getState().setSnapshot([vessel("257000001")]);
    await render(<ListScreen />);
    await fireEvent.press(screen.getByTestId("list-filter-sea"));
    expect(screen.getByText("No aircraft in range right now.")).toBeOnTheScreen();
    expect(screen.queryByText("No traffic in range")).not.toBeOnTheScreen();
  });

  it("collapses and expands a section from its heading; the count stays visible", async () => {
    seedTraffic();
    useSettingsStore.setState({ showPlanets: true });
    await render(<ListScreen />);
    expect(expanded("list-section-traffic")).toBe(true);

    await fireEvent.press(screen.getByTestId("list-section-traffic"));
    expect(expanded("list-section-traffic")).toBe(false);
    expect(screen.queryAllByTestId(/^list-(ac|ship)-/)).toHaveLength(0);
    expect(screen.getByTestId("list-count")).toHaveTextContent("Traffic (3)");
    // Other sections are unaffected.
    expect(expanded("list-section-sky")).toBe(true);
    expect(screen.getByTestId("list-sky-count")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("list-section-traffic"));
    expect(screen.getAllByTestId(/^list-ac-/)).toHaveLength(2);
  });

  it("hiding every kind of a section removes it; hiding everything offers Show all", async () => {
    seedTraffic();
    await render(<ListScreen />);

    await fireEvent.press(screen.getByTestId("list-filter-air"));
    expect(screen.getByTestId("list-section-traffic")).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId("list-filter-sea"));
    expect(screen.queryByTestId("list-section-traffic")).not.toBeOnTheScreen();
    expect(screen.getByText("Everything is filtered out")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("list-show-all"));
    expect(screen.queryByText("Everything is filtered out")).not.toBeOnTheScreen();
    expect(screen.getByTestId("list-count")).toHaveTextContent("Traffic (3)");
    expect(pressed("list-filter-air")).toBe(true);
    expect(pressed("list-filter-sea")).toBe(true);
  });

  it("does not change the layer settings the AR view and the map draw from", async () => {
    seedTraffic();
    await render(<ListScreen />);
    await fireEvent.press(screen.getByTestId("list-filter-sea"));
    expect(useSettingsStore.getState()).toMatchObject({ showShips: true, showAton: true });
  });

  it("keeps an open card when its kind is hidden or its section collapsed", async () => {
    seedTraffic();
    await render(<ListScreen />);
    await fireEvent.press(screen.getByTestId("list-ac-abc123"));
    expect(within(screen.getByTestId("detail-card")).getByText("SAS123")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("list-filter-air"));
    expect(within(screen.getByTestId("detail-card")).getByText("SAS123")).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId("list-section-traffic"));
    expect(screen.getByTestId("detail-card")).toBeOnTheScreen();
  });

  it("restores the hidden kinds and collapsed sections after a relaunch", async () => {
    seedTraffic();
    useSettingsStore.setState({ showPlanets: true });
    const first = await render(<ListScreen />);
    await fireEvent.press(screen.getByTestId("list-filter-sea"));
    await fireEvent.press(screen.getByTestId("list-section-sky"));
    await act(async () => {}); // let the async SecureStore write land

    const secureStore = jest.requireMock<{ __data: Map<string, string> }>("expo-secure-store").__data;
    const saved = secureStore.get(SETTINGS_KEY);
    expect(saved).toBeDefined();
    await first.unmount();

    // A relaunch: in-memory state back to the defaults, then rehydrated from what was saved.
    useSettingsStore.setState({ listHiddenKinds: [], listCollapsedSections: [] });
    secureStore.set(SETTINGS_KEY, saved as string);
    await act(() => useSettingsStore.persist.rehydrate());

    await render(<ListScreen />);
    expect(pressed("list-filter-sea")).toBe(false);
    expect(screen.queryByTestId("list-ship-257000001")).not.toBeOnTheScreen();
    expect(screen.getByTestId("list-ac-abc123")).toBeOnTheScreen();
    expect(expanded("list-section-sky")).toBe(false);
    expect(screen.queryAllByTestId(/^list-planet-/)).toHaveLength(0);
  });
});
