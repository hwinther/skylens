/**
 * ArOverlay's non-aircraft passes (the aircraft pass is covered through the AR screen): the ship /
 * AtoN surface band, airports, satellites, planets and radio sources. Each draws only what is in
 * front of the camera, only while its layer is on, and hands a tap back with the object's id (which
 * opens the matching card on the AR screen).
 *
 * Fixed pose: looking due north at the horizon from (59.9, 10.75). The projection loop runs on
 * requestAnimationFrame, so frames are stepped with fake timers.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { ArOverlay, type ArOverlayProps } from "@/components/ArOverlay";
import type { CameraPose, GeoPoint, PlanetView, RadioTargetView, SatelliteView } from "@/ar";
import type { AirportDto, VesselDto } from "@/api/types";

const pose: { current: CameraPose } = { current: { azimuth: 0, elevation: 0, roll: 0 } };
const position: { current: GeoPoint | null } = { current: { lat: 59.9, lon: 10.75, alt: 0 } };

const vessel = (mmsi: string, over: Partial<VesselDto>): VesselDto => ({ mmsi, kind: "ship", ...over });
// ~5 km north / south, and ~55 km north (past the 40 km band cap).
const SHIP_N = vessel("257000001", { name: "NORDLYS", lat: 59.945, lon: 10.75 });
const SHIP_S = vessel("257000002", { name: "SOUTHBOUND", lat: 59.855, lon: 10.75 });
const SHIP_FAR = vessel("257000003", { name: "FARAWAY", lat: 60.4, lon: 10.75 });
const ATON_N = vessel("992570001", { kind: "aton", name: "LIGHT", lat: 59.95, lon: 10.76 });

const sat = (noradId: number, azimuthDeg: number, elevationDeg: number): SatelliteView => ({
  noradId,
  name: `SAT ${noradId}`,
  group: "stations",
  azimuthDeg,
  elevationDeg,
  azimuthRateDegS: 0,
  elevationRateDegS: 0,
  rangeKm: 800,
  rangeRateKmS: 0,
  subLat: 60,
  subLon: 10,
});
const planet = (body: string, azimuthDeg: number, elevationDeg: number): PlanetView => ({
  body,
  name: body,
  azimuthDeg,
  elevationDeg,
  magnitude: -2,
  phasePercent: 90,
  distanceAu: 4,
  constellation: "Taurus",
});
const radio = (key: string, azimuthDeg: number, elevationDeg: number): RadioTargetView =>
  ({ key, name: key, short: key, azimuthDeg, elevationDeg, raHours: 0, decDeg: 0 }) as RadioTargetView;
const airport = (ident: string, lat: number): AirportDto =>
  ({ ident, name: ident, type: "large_airport", lat, lon: 10.75, elevationFt: 600 }) as AirportDto;

const handlers = {
  onSelect: jest.fn(),
  onSelectVessel: jest.fn(),
  onSelectSatellite: jest.fn(),
  onSelectPlanet: jest.fn(),
  onSelectRadio: jest.fn(),
  onSelectAirport: jest.fn(),
};

function props(over: Partial<ArOverlayProps> = {}): ArOverlayProps {
  return {
    aircraft: [],
    snapshotAt: Date.now(),
    poseRef: pose,
    positionRef: position,
    hFovDeg: 66,
    ...handlers,
    ...over,
  };
}

async function frames() {
  await act(async () => jest.advanceTimersByTime(200));
}

describe("ArOverlay layers", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("pins ships in front of the camera to the horizon band, within range, and only while shown", async () => {
    const vessels = [SHIP_N, SHIP_S, SHIP_FAR, ATON_N];
    const view = await render(
      <ArOverlay {...props({ vessels, vesselsSnapshotAt: Date.now(), showShips: true, showAton: false })} />,
    );
    await frames();

    expect(screen.getByTestId("ves-label-257000001")).toHaveTextContent(/NORDLYS/);
    expect(screen.queryByTestId("ves-label-257000002")).not.toBeOnTheScreen(); // behind
    expect(screen.queryByTestId("ves-label-257000003")).not.toBeOnTheScreen(); // past the band cap
    expect(screen.queryByTestId("ves-label-992570001")).not.toBeOnTheScreen(); // AtoN layer off

    await fireEvent.press(screen.getByTestId("ves-name-257000001"));
    expect(handlers.onSelectVessel).toHaveBeenCalledWith("257000001");

    await view.rerender(<ArOverlay {...props({ vessels, showShips: false, showAton: true })} />);
    await frames();
    expect(screen.queryByTestId("ves-label-257000001")).not.toBeOnTheScreen();
    expect(screen.getByTestId("ves-label-992570001")).toBeOnTheScreen();
  });

  it("draws airports, satellites, planets and radio sources in front of the camera, and opens them on tap", async () => {
    await render(
      <ArOverlay
        {...props({
          airports: [airport("ENGM", 60.0), airport("SOUTH", 59.8)],
          showAirports: true,
          satellites: [sat(25544, 10, 15), sat(99999, 180, 40)],
          satellitesSampledAt: Date.now(),
          showSatellites: true,
          planets: [planet("Mars", 355, 8), planet("Venus", 200, 10)],
          showPlanets: true,
          radioTargets: [radio("casA", 5, 20), radio("tauA", 170, 20)],
          showRadioSky: true,
        })}
      />,
    );
    await frames();

    expect(screen.getByTestId("ar-airport-ENGM")).toBeOnTheScreen();
    expect(screen.queryByTestId("ar-airport-SOUTH")).not.toBeOnTheScreen();
    expect(screen.getByTestId("sat-label-25544")).toBeOnTheScreen();
    expect(screen.queryByTestId("sat-label-99999")).not.toBeOnTheScreen();
    expect(screen.getByTestId("planet-label-Mars")).toBeOnTheScreen();
    expect(screen.queryByTestId("planet-label-Venus")).not.toBeOnTheScreen();
    expect(screen.getByTestId("radio-label-casA")).toBeOnTheScreen();
    expect(screen.queryByTestId("radio-label-tauA")).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("ar-airport-ENGM"));
    await fireEvent.press(screen.getByTestId("sat-label-25544"));
    await fireEvent.press(screen.getByTestId("planet-label-Mars"));
    await fireEvent.press(screen.getByTestId("radio-label-casA"));
    expect(handlers.onSelectAirport).toHaveBeenCalledWith("ENGM");
    expect(handlers.onSelectSatellite).toHaveBeenCalledWith(25544);
    expect(handlers.onSelectPlanet).toHaveBeenCalledWith("Mars");
    expect(handlers.onSelectRadio).toHaveBeenCalledWith("casA");
  });

  it("draws none of those layers while they are switched off", async () => {
    await render(
      <ArOverlay
        {...props({
          airports: [airport("ENGM", 60.0)],
          satellites: [sat(25544, 10, 15)],
          planets: [planet("Mars", 355, 8)],
          radioTargets: [radio("casA", 5, 20)],
        })}
      />,
    );
    await frames();

    expect(screen.queryByTestId("ar-airport-ENGM")).not.toBeOnTheScreen();
    expect(screen.queryByTestId("sat-label-25544")).not.toBeOnTheScreen();
    expect(screen.queryByTestId("planet-label-Mars")).not.toBeOnTheScreen();
    expect(screen.queryByTestId("radio-label-casA")).not.toBeOnTheScreen();
  });

  it("collapses overlapping satellites into a +N chip instead of stacking labels", async () => {
    // Twelve satellites within a degree of each other: declutter keeps a few and counts the rest.
    const crowd = Array.from({ length: 12 }, (_, i) => sat(40000 + i, 10 + i * 0.05, 15));
    await render(<ArOverlay {...props({ satellites: crowd, satellitesSampledAt: Date.now(), showSatellites: true })} />);
    await frames();

    const shown = screen.getAllByTestId(/^sat-label-/).length;
    expect(shown).toBeLessThan(12);
    expect(screen.getByText(`+${12 - shown}`)).toBeOnTheScreen();
  });
});
