/**
 * The followed object's identity summary in the cockpit card (src/components/cockpitSummary.ts): the
 * parts per line, and that missing fields drop out instead of leaving "undefined" or empty separators.
 */
import { orbitInfo } from "@/ar/orbitClass";
import {
  aircraftIdentityLines,
  routeText,
  satelliteIdentityLines,
  vesselIdentityLines,
  type SummaryParts,
} from "@/components/cockpitSummary";

/** What SheetSummary renders: each non-empty line's parts joined by " · ". */
const render = (lines: SummaryParts[]) =>
  lines.map((parts) => parts.filter(Boolean).join(" · ")).filter((line) => line !== "");

describe("routeText", () => {
  it("shows both ends, or the one known end, or nothing", () => {
    expect(routeText({ originIcao: "ESSA", destinationIcao: "ENGM" })).toBe("ESSA → ENGM");
    expect(routeText({ originIcao: " ESSA ", destinationIcao: null })).toBe("From ESSA");
    expect(routeText({ originIcao: "", destinationIcao: "ENGM" })).toBe("To ENGM");
    expect(routeText({ originIcao: null, destinationIcao: "  " })).toBeNull();
    expect(routeText(null)).toBeNull();
  });
});

describe("aircraftIdentityLines", () => {
  const metadata = { typeName: "Boeing 737-800", typeCode: "B738", registration: "LN-RKF", operator: "SAS" };

  it("type, registration and operator, then the route", () => {
    expect(
      render(aircraftIdentityLines({ metadata, route: { originIcao: "ENGM", destinationIcao: "EGLL" }, hex: "4ca123", hasCallsign: true })),
    ).toEqual(["Boeing 737-800 · LN-RKF · SAS", "ENGM → EGLL"]);
  });

  it("falls back to the type code and drops what is missing", () => {
    expect(render(aircraftIdentityLines({ metadata: { typeCode: "B738", registration: " ", operator: null } }))).toEqual([
      "B738",
    ]);
  });

  it("without any metadata shows the ICAO address when the title is the callsign, plus flags", () => {
    expect(render(aircraftIdentityLines({ hex: "4ca123", hasCallsign: true, military: true, signalLost: true }))).toEqual([
      "Signal lost · ICAO 4CA123 · Military",
    ]);
    // The title already is the hex: nothing to add.
    expect(render(aircraftIdentityLines({ hex: "4ca123", hasCallsign: false }))).toEqual([]);
  });
});

describe("vesselIdentityLines", () => {
  it("type and call sign, then the destination; the register type stands in for a missing AIS type", () => {
    expect(
      render(vesselIdentityLines({ metadata: { shipTypeText: "Passenger", callSign: "LHWR", destination: "KIEL" } })),
    ).toEqual(["Passenger · Call sign LHWR", "→ KIEL"]);
    expect(render(vesselIdentityLines({ metadata: { registerType: "Fiskefartøy", destination: null } }))).toEqual([
      "Fiskefartøy",
    ]);
  });

  it("the nav status only when nothing else is known", () => {
    expect(render(vesselIdentityLines({ metadata: null, navStatus: "Moored" }))).toEqual(["Moored"]);
    expect(render(vesselIdentityLines({ metadata: { destination: "OSLO" }, navStatus: "Moored" }))).toEqual(["→ OSLO"]);
    expect(render(vesselIdentityLines({}))).toEqual([]);
  });

  it("an aid to navigation shows its aid type, never a distance", () => {
    expect(render(vesselIdentityLines({ aton: { aidType: "Cardinal mark N", virtual: true } }))).toEqual([
      "Cardinal mark N · Virtual aid",
    ]);
  });
});

describe("satelliteIdentityLines", () => {
  const iss = orbitInfo({ MEAN_MOTION: 15.49, ECCENTRICITY: 0.0007, INCLINATION: 51.6 });

  it("orbit class in words and the period, then the active transmitters", () => {
    expect(render(satelliteIdentityLines(iss, 3))).toEqual(["Low Earth orbit · 93 min period", "3 active transmitters"]);
    expect(render(satelliteIdentityLines(iss, 1))).toEqual(["Low Earth orbit · 93 min period", "1 active transmitter"]);
  });

  it("without the orbit or transmitters: nothing", () => {
    expect(render(satelliteIdentityLines(null, 0))).toEqual([]);
    expect(render(satelliteIdentityLines(null, null))).toEqual([]);
  });
});
