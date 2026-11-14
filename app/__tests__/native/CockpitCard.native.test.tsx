/**
 * The cockpit view's card (SimCard). For the FOLLOWED object the collapsed summary says what it is
 * (identity), not the altitude / speed the HUD shows or a distance from the user, and there is no
 * actions row ("Show on map" / "Show ground track" are the screen's Map chip or minimap there). Other
 * traffic tapped in the scene keeps the live summary, its distance from the followed object, "Show on
 * map" and "Follow this".
 */
import { act, render, screen, within } from "@testing-library/react-native";
import { SimCard, type SimCardProps } from "@/components/SimCard";
import { useAuthStore } from "@/state/authStore";
import { useVesselStore } from "@/state/vesselStore";
import { aircraft, backendJson, ISS_DTO, resetStores, routeFetch, seedAircraft } from "./fixtures";

const HEX = "abc123";
const DETAIL = {
  metadata: { hex: HEX, registration: "LN-RKF", typeCode: "B738", typeName: "Boeing 737-800", operator: "SAS" },
};
const ROUTE = { originIcao: "ENGM", destinationIcao: "EGLL" };
const notFound = () => new Response(null, { status: 404, headers: { "X-Skylens-Api": "1" } });

const summaryText = () =>
  within(screen.getByTestId("detail-card-summary"))
    .getAllByText(/./)
    .map((n) => String(n.props.children));

async function renderCard(over: Partial<SimCardProps>) {
  const props: SimCardProps = {
    target: { kind: "aircraft", id: HEX },
    selection: { kind: "aircraft", id: HEX },
    onClose: jest.fn(),
    onFollow: jest.fn(),
    followedLost: false,
    origin: { lat: 59.95, lon: 10.8 },
    onRoute: jest.fn(),
    ...over,
  };
  await render(<SimCard {...props} />);
  await act(async () => {});
  return props;
}

describe("SimCard: the followed object's card", () => {
  beforeEach(() => {
    resetStores();
    seedAircraft([
      aircraft(HEX, { flight: "SAS123", alt: 34000, gs: 451 }),
      aircraft("def456", { flight: "NOZ77", lat: 60.0, lon: 10.8, alt: 11200, gs: 200 }),
    ]);
  });

  it("aircraft: type, registration and operator, then the known route; no altitude, speed or distance", async () => {
    useAuthStore.setState({ authRequired: false });
    const requested = routeFetch({
      [`/api/aircraft/${HEX}`]: () => backendJson(DETAIL),
      [`/api/aircraft/${HEX}/route/cached`]: () => backendJson(ROUTE),
    });
    const props = await renderCard({});

    expect(summaryText()).toEqual(["Boeing 737-800 · LN-RKF · SAS", "ENGM → EGLL"]);
    expect(screen.getByTestId("detail-card-summary")).not.toHaveTextContent(/ft|kt|km/);
    // No actions row: no Show on map (the Map chip / minimap), no cockpit action, no Follow this.
    expect(screen.queryByTestId("detail-show-on-map")).toBeNull();
    expect(screen.queryByTestId("detail-cockpit")).toBeNull();
    expect(screen.queryByTestId("sim-follow")).toBeNull();
    expect(props.onRoute).toHaveBeenCalledWith(HEX, ROUTE);
    expect(requested).not.toContain(`/api/aircraft/${HEX}/route`); // never the paid lookup
  });

  it("aircraft without a known route or metadata: one line, no empty separators", async () => {
    useAuthStore.setState({ authRequired: false });
    routeFetch({
      [`/api/aircraft/${HEX}`]: () => backendJson({ metadata: { hex: HEX, typeCode: "B738" } }),
      [`/api/aircraft/${HEX}/route/cached`]: notFound,
    });
    await renderCard({});
    // The bare designator reads as the type table's name.
    expect(summaryText()).toEqual(["Boeing 737-800"]);
  });

  it("aircraft while signed out: its ICAO address (the title is the callsign), fetching nothing", async () => {
    const requested = routeFetch({});
    await renderCard({ followedLost: true });
    expect(requested).toEqual([]);
    expect(screen.getByTestId("detail-title")).toHaveTextContent("SAS123");
    expect(summaryText()).toEqual(["Signal lost · ICAO ABC123"]);
    expect(screen.queryByTestId("detail-show-on-map")).toBeNull();
  });

  it("other traffic tapped in the scene keeps the live summary, distance from the followed object, and its actions", async () => {
    await renderCard({ selection: { kind: "aircraft", id: "def456" } });
    expect(screen.getByTestId("detail-title")).toHaveTextContent("NOZ77");
    // ~5.6 km north of the followed aircraft (origin), not of the user.
    expect(screen.getByTestId("detail-card-summary")).toHaveTextContent(/^11,200 ft · 200 kt · 5\.6 km N$/);
    expect(screen.getByTestId("detail-show-on-map")).toBeOnTheScreen();
    expect(screen.getByTestId("sim-follow")).toBeOnTheScreen();
  });

  it("vessel: type, call sign and destination; no speed, course or distance, no Show on map", async () => {
    useAuthStore.setState({ authRequired: false });
    const mmsi = "257000001";
    useVesselStore.getState().setSnapshot([
      { mmsi, kind: "ship", name: "COLOR MAGIC", flag: "NO", lat: 59.94, lon: 10.79, sog: 12, cog: 200, seen: 1 },
    ]);
    routeFetch({
      [`/api/vessels/${mmsi}`]: () =>
        backendJson({
          state: null,
          metadata: { mmsi, shipTypeText: "Passenger", callSign: "LHWR", destination: "KIEL" },
        }),
    });
    await renderCard({ target: { kind: "vessel", id: mmsi }, selection: { kind: "vessel", id: mmsi } });

    expect(screen.getByTestId("vessel-detail-title")).toHaveTextContent("COLOR MAGIC");
    expect(summaryText()).toEqual(["Passenger · Call sign LHWR", "→ KIEL"]);
    expect(screen.queryByTestId("vessel-show-on-map")).toBeNull();
    expect(screen.queryByTestId("sim-follow")).toBeNull();
  });

  it("vessel without metadata (signed out): its nav status, or no summary at all", async () => {
    const mmsi = "257000002";
    useVesselStore.getState().setSnapshot([
      { mmsi, kind: "ship", name: "MOORED ONE", lat: 59.94, lon: 10.79, sog: 0, navStatus: 5, seen: 1 },
    ]);
    routeFetch({});
    await renderCard({ target: { kind: "vessel", id: mmsi }, selection: { kind: "vessel", id: mmsi } });
    expect(summaryText()).toEqual(["Moored"]);
  });

  it("satellite: orbit class and period plus active transmitters, no El/Az/range and no ground-track button", async () => {
    useAuthStore.setState({ authRequired: false });
    routeFetch({
      "/api/satellites/25544": () =>
        backendJson({
          satellite: ISS_DTO,
          transmitters: [
            { description: "APRS", downlinkLowHz: 145_825_000, alive: true },
            { description: "Old beacon", downlinkLowHz: 145_800_000, alive: false },
          ],
        }),
    });
    await renderCard({ target: { kind: "satellite", id: "25544" }, selection: { kind: "satellite", id: "25544" } });

    expect(summaryText()).toEqual(["Low Earth orbit · 93 min period", "1 active transmitter"]);
    expect(screen.queryByTestId("sat-show-ground-track")).toBeNull();
    expect(screen.queryByTestId("sat-cockpit")).toBeNull();
  });
});
