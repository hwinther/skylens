/**
 * Detail cards that call the API. Two contracts with real cost behind them:
 *  - DetailSheet: GET /api/aircraft/{hex}/route spends AeroAPI quota, so it is only ever called on a
 *    tap of "Route"; opening the card may only read the free cached route.
 *  - SatelliteDetailSheet: the SatNOGS transmitter list is fetched only while the API may be called.
 * Both show what the live snapshot already has (and fetch nothing) when signed out behind auth.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { ApiClient } from "@/api/client";
import { DetailSheet } from "@/components/DetailSheet";
import { SatelliteDetailSheet } from "@/components/SatelliteDetailSheet";
import { useAuthStore } from "@/state/authStore";
import type { SatelliteView } from "@/ar";
import { aircraft, backendJson, resetStores, routeFetch, seedAircraft } from "./fixtures";

const HEX = "abc123";
const DETAIL = {
  metadata: { hex: HEX, registration: "LN-RKF", typeCode: "B738", typeName: "Boeing 737-800", operator: "SAS" },
};
const ROUTE = { originIcao: "ENGM", destinationIcao: "EGLL", originName: "Oslo", destinationName: "Heathrow" };

const notFound = () => new Response(null, { status: 404, headers: { "X-Skylens-Api": "1" } });

/** Let the fetches resolve, then expand the compact card to its full body. */
async function settleAndExpand() {
  await act(async () => {});
  await fireEvent.press(screen.getByTestId("detail-card-toggle"));
}

describe("DetailSheet (aircraft)", () => {
  // Built per test: ApiClient binds fetch when constructed, and setup.ts installs the fetch spy per test.
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient({ baseUrl: "http://api.test" });
    resetStores();
    seedAircraft([aircraft(HEX, { flight: "SAS123", alt: 12000 })]);
  });

  it("only calls the paid route lookup when the user taps Route", async () => {
    useAuthStore.setState({ authRequired: false });
    const requested = routeFetch({
      [`/api/aircraft/${HEX}`]: () => backendJson(DETAIL),
      [`/api/aircraft/${HEX}/route/cached`]: notFound,
      [`/api/aircraft/${HEX}/route`]: () => backendJson(ROUTE),
    });
    await render(<DetailSheet hex={HEX} client={client} onClose={jest.fn()} />);
    await settleAndExpand();

    expect(screen.getByText("LN-RKF")).toBeOnTheScreen();
    expect(requested).not.toContain(`/api/aircraft/${HEX}/route`);

    await fireEvent.press(screen.getByText("Route (uses AeroAPI)"));
    await act(async () => {});

    expect(requested.filter((p) => p === `/api/aircraft/${HEX}/route`)).toHaveLength(1);
    expect(screen.getByText("ENGM → EGLL")).toBeOnTheScreen();
    expect(screen.queryByText("Route (uses AeroAPI)")).not.toBeOnTheScreen();
  });

  it("shows an already-cached route straight away, without the paid lookup", async () => {
    useAuthStore.setState({ authRequired: false });
    const requested = routeFetch({
      [`/api/aircraft/${HEX}`]: () => backendJson(DETAIL),
      [`/api/aircraft/${HEX}/route/cached`]: () => backendJson(ROUTE),
    });
    await render(<DetailSheet hex={HEX} client={client} onClose={jest.fn()} />);
    await settleAndExpand();

    expect(screen.getByText("ENGM → EGLL")).toBeOnTheScreen();
    expect(screen.queryByText("Route (uses AeroAPI)")).not.toBeOnTheScreen();
    expect(requested).not.toContain(`/api/aircraft/${HEX}/route`);
  });

  it("signed out behind auth: fetches nothing and shows the live snapshot with a sign-in hint", async () => {
    const requested = routeFetch({});
    await render(<DetailSheet hex={HEX} client={client} onClose={jest.fn()} />);
    await settleAndExpand();

    expect(requested).toEqual([]);
    expect(screen.getByTestId("detail-title")).toHaveTextContent("SAS123");
    expect(screen.getByText("12,000 ft")).toBeOnTheScreen();
    expect(screen.getByTestId("detail-signin-hint")).toBeOnTheScreen();
    expect(screen.queryByText("Route (uses AeroAPI)")).not.toBeOnTheScreen();
  });

  it("keeps the live data when the detail lookup fails, and says why", async () => {
    useAuthStore.setState({ authRequired: false });
    routeFetch({
      [`/api/aircraft/${HEX}`]: () => backendJson({ error: "boom" }, 500),
      [`/api/aircraft/${HEX}/route/cached`]: notFound,
    });
    await render(<DetailSheet hex={HEX} client={client} onClose={jest.fn()} />);
    await settleAndExpand();

    expect(screen.getByText(`GET /api/aircraft/${HEX} → 500`)).toBeOnTheScreen();
    expect(screen.getByText("SAS123")).toBeOnTheScreen();
    expect(screen.getByTestId("detail-show-on-map")).toBeOnTheScreen();
  });
});

describe("SatelliteDetailSheet", () => {
  const VIEW: SatelliteView = {
    noradId: 25544,
    name: "ISS (ZARYA)",
    group: "stations",
    azimuthDeg: 120,
    elevationDeg: 35,
    azimuthRateDegS: 0,
    elevationRateDegS: 0,
    rangeKm: 700,
    rangeRateKmS: -5,
    subLat: 58,
    subLon: 12,
  };
  const SAT_DETAIL = {
    satellite: { noradId: 25544, name: "ISS (ZARYA)", group: "stations", omm: null },
    transmitters: [
      { description: "Old beacon", downlinkLowHz: 145_800_000, alive: false },
      { description: "APRS digipeater", mode: "AFSK", baud: 1200, downlinkLowHz: 145_825_000, alive: true },
    ],
  };

  beforeEach(() => {
    resetStores();
  });

  it("lists the transmitters, active first, with live Doppler only for the active downlink", async () => {
    useAuthStore.setState({ authRequired: false });
    routeFetch({ "/api/satellites/25544": () => backendJson(SAT_DETAIL) });
    await render(<SatelliteDetailSheet noradId={25544} view={VIEW} onClose={jest.fn()} />);
    await settleAndExpand();

    expect(screen.getByTestId("sat-tx-0")).toHaveTextContent(/APRS digipeater/);
    expect(screen.getByTestId("sat-tx-1")).toHaveTextContent(/Old beacon/);
    // Approaching (negative range rate): the received downlink is above the nominal 145.825 MHz.
    expect(screen.getByTestId("sat-tx-doppler-0")).toHaveTextContent("Doppler 145.827 MHz");
    expect(screen.queryByTestId("sat-tx-doppler-1")).not.toBeOnTheScreen();
  });

  it("says when a satellite has no transmitter data", async () => {
    useAuthStore.setState({ authRequired: false });
    routeFetch({ "/api/satellites/25544": () => backendJson({ ...SAT_DETAIL, transmitters: [] }) });
    await render(<SatelliteDetailSheet noradId={25544} view={VIEW} onClose={jest.fn()} />);
    await settleAndExpand();

    expect(screen.getByTestId("sat-detail-empty")).toBeOnTheScreen();
  });

  it("fetches nothing while signed out behind auth, and still shows the live view", async () => {
    const requested = routeFetch({});
    await render(<SatelliteDetailSheet noradId={25544} view={VIEW} onClose={jest.fn()} />);
    await settleAndExpand();

    expect(requested).toEqual([]);
    expect(screen.getByText("ISS (ZARYA)")).toBeOnTheScreen();
    expect(screen.queryByTestId("sat-tx-0")).not.toBeOnTheScreen();
  });
});
