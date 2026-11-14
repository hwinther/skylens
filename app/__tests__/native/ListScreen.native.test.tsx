/**
 * List tab: one row per positioned aircraft from aircraftStore, nearest first. Tapping a row opens
 * that aircraft's detail card; tapping another row swaps the card (one card per screen, never two).
 */
import { act, render, screen, fireEvent, within } from "@testing-library/react-native";
import ListScreen from "../../app/list";
import { aircraft, resetStores, seedAircraft } from "./fixtures";

describe("ListScreen", () => {
  beforeEach(() => {
    resetStores();
  });

  it("lists the positioned aircraft from the store, nearest first", async () => {
    seedAircraft([
      aircraft("far001", { flight: "FAR1", lat: 60.3, lon: 10.75 }),
      aircraft("near01", { flight: "NEAR1", lat: 59.91, lon: 10.75 }),
      aircraft("nopos1", { flight: "NOPOS", lat: null, lon: null }),
    ]);
    await render(<ListScreen />);

    expect(screen.getByTestId("list-count")).toHaveTextContent("Traffic (2)");
    const rows = screen.getAllByTestId(/^list-ac-/).map((r) => r.props.testID);
    expect(rows).toEqual(["list-ac-near01", "list-ac-far001"]);
    expect(screen.queryByTestId("list-ac-nopos1")).not.toBeOnTheScreen();
  });

  it("shows a readable type line under the callsign where the designator is known, with the type-data credit", async () => {
    seedAircraft([
      aircraft("abc123", { flight: "SAS123", t: "B738" }),
      aircraft("heli01", { flight: "LIFE1", lat: 59.97, t: "EC35" }),
      aircraft("odd001", { flight: "ODD1", lat: 59.98, t: "ZZ99" }),
      aircraft("none01", { flight: "NONE1", lat: 59.99 }),
    ]);
    await render(<ListScreen />);

    expect(screen.getByTestId("list-typeline-abc123")).toHaveTextContent("Boeing 737-800 · B738");
    expect(screen.getByTestId("list-typeline-heli01")).toHaveTextContent("Airbus Helicopters EC-135/635 · EC35");
    expect(screen.getByTestId("list-typeline-odd001")).toHaveTextContent("ZZ99");
    expect(screen.queryByTestId("list-typeline-none01")).not.toBeOnTheScreen();
    expect(screen.getByTestId("list-type-credit")).toBeOnTheScreen();
  });

  it("no type-data credit when no row uses the type table", async () => {
    seedAircraft([aircraft("abc123", { flight: "SAS123" })]);
    await render(<ListScreen />);
    expect(screen.queryByTestId("list-type-credit")).not.toBeOnTheScreen();
  });

  it("follows store updates", async () => {
    await render(<ListScreen />);
    expect(screen.getByText("No traffic in range")).toBeOnTheScreen();

    await act(async () => seedAircraft([aircraft("abc123", { flight: "SAS123" })]));
    expect(screen.getByTestId("list-ac-abc123")).toHaveTextContent(/SAS123/);
  });

  it("opens the card for a tapped row, and swaps it for another row", async () => {
    seedAircraft([
      aircraft("abc123", { flight: "SAS123" }),
      aircraft("def456", { flight: "NAX456", lat: 59.97 }),
    ]);
    await render(<ListScreen />);
    expect(screen.queryByTestId("detail-card")).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("list-ac-abc123"));
    expect(within(screen.getByTestId("detail-card")).getByText("SAS123")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("list-ac-def456"));
    expect(screen.getAllByTestId("detail-card")).toHaveLength(1);
    const card = screen.getByTestId("detail-card");
    expect(within(card).getByText("NAX456")).toBeOnTheScreen();
    expect(within(card).queryByText("SAS123")).not.toBeOnTheScreen();
  });
});
