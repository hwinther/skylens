import {
  aircraftTypeLabel,
  aircraftTypeLine,
  describeAircraftType,
  isRotorcraftType,
  lookupAircraftType,
  prettyTypeName,
  shortTypeName,
} from "@/aircraft/aircraftType";
import { iconForAircraft } from "@/components/aircraftIcon";
import table from "@/aircraft/aircraft-types.json";

describe("lookupAircraftType", () => {
  it("parses a jet airliner", () => {
    expect(lookupAircraftType("B738")).toEqual({
      code: "B738",
      name: "Boeing 737-800",
      description: "L2J",
      cls: "landplane",
      engines: 2,
      engineType: "jet",
      wake: "medium",
    });
  });

  it("parses a helicopter, case-insensitively and trimmed", () => {
    expect(lookupAircraftType(" ec35 ")).toMatchObject({
      code: "EC35",
      name: "Airbus Helicopters EC-135/635",
      cls: "helicopter",
      engines: 2,
      engineType: "turbine",
      wake: "light",
    });
  });

  it("names the source's unnamed placeholder types and has no engine for a glider", () => {
    expect(lookupAircraftType("BALL")).toMatchObject({ name: "Balloon", cls: "lighter-than-air", engines: null, wake: null });
    expect(lookupAircraftType("GLID")).toMatchObject({ name: "Glider", cls: "landplane", engines: null, engineType: null });
  });

  it("misses unknown, blank and missing designators, and leaves ground objects out", () => {
    expect(lookupAircraftType("ZZ99")).toBeNull();
    expect(lookupAircraftType("")).toBeNull();
    expect(lookupAircraftType(null)).toBeNull();
    expect(lookupAircraftType(undefined)).toBeNull();
    expect(lookupAircraftType("TWR")).toBeNull();
    expect(lookupAircraftType("ZZZZ")).toBeNull();
  });

  it("every entry is a well-formed description + wake category", () => {
    const types = (table as { types: Record<string, string> }).types;
    expect(Object.keys(types).length).toBeGreaterThan(2500);
    for (const [code, entry] of Object.entries(types)) {
      expect(code).toMatch(/^[A-Z0-9]{2,4}$/);
      expect(entry.slice(0, 4)).toMatch(/^[A-Z-][0-9C-][A-Z-][LMHJ-]$/);
    }
    // The ODC-By notice travels with the data.
    expect((table as { license: string }).license).toContain("ODC Attribution License");
  });
});

describe("isRotorcraftType", () => {
  it("is true for helicopters and gyrocopters, false for aeroplanes and tiltrotors, null when unknown", () => {
    expect(isRotorcraftType("EC45")).toBe(true);
    expect(isRotorcraftType("R44")).toBe(true);
    expect(isRotorcraftType("GYRO")).toBe(true);
    expect(isRotorcraftType("A320")).toBe(false);
    expect(isRotorcraftType("V22")).toBe(false);
    expect(isRotorcraftType("ZZ99")).toBeNull();
    expect(isRotorcraftType(null)).toBeNull();
  });
});

describe("prettyTypeName / shortTypeName", () => {
  it("title-cases the capitalised manufacturer and keeps the model as written", () => {
    expect(prettyTypeName("BOEING 737-800")).toBe("Boeing 737-800");
    expect(prettyTypeName("DE HAVILLAND DHC-8-400 Dash 8")).toBe("De Havilland DHC-8-400 Dash 8");
    expect(prettyTypeName("BELL-BOEING V-22 Osprey")).toBe("Bell-Boeing V-22 Osprey");
    expect(prettyTypeName("MCDONNELL-DOUGLAS MD-11")).toBe("McDonnell-Douglas MD-11");
    expect(prettyTypeName("PZL-MIELEC M-28 Skytruck")).toBe("PZL-Mielec M-28 Skytruck");
  });

  it("keeps acronyms and a last all-caps word (the model)", () => {
    expect(prettyTypeName("BRITISH AEROSPACE ATP")).toBe("British Aerospace ATP");
    expect(prettyTypeName("CASA C-212 Aviocar")).toBe("CASA C-212 Aviocar");
    expect(prettyTypeName("IAI Westwind")).toBe("IAI Westwind");
    expect(prettyTypeName("AEROPUP")).toBe("AEROPUP");
  });

  it("leaves mixed-case names alone", () => {
    expect(prettyTypeName("Boeing 737-8JP")).toBe("Boeing 737-8JP");
    expect(prettyTypeName("  Cessna 172S  ")).toBe("Cessna 172S");
  });

  it("shortens only long names, keeping the first manufacturer word (two after a particle)", () => {
    expect(shortTypeName("BOEING 737-800")).toBe("Boeing 737-800");
    expect(shortTypeName("AIRBUS HELICOPTERS EC-135/635")).toBe("Airbus EC-135/635");
    expect(shortTypeName("HAWKER BEECHCRAFT Hawker 750/850")).toBe("Hawker 750/850");
    expect(shortTypeName("DE HAVILLAND CANADA DHC-6 Twin Otter")).toBe("De Havilland DHC-6 Twin Otter");
    expect(shortTypeName("AEROSPATIALE AS-350 Ecureuil")).toBe("Aerospatiale AS-350 Ecureuil");
  });
});

describe("aircraftTypeLabel", () => {
  it("prefers the airframe's own name, then the table, then the code", () => {
    expect(aircraftTypeLabel({ typeName: "BOEING 737-86N", typeCode: "B738" })).toBe("Boeing 737-86N");
    expect(aircraftTypeLabel({ typeName: " ", typeCode: "b738" })).toBe("Boeing 737-800");
    expect(aircraftTypeLabel({ typeCode: "ZZ99" })).toBe("ZZ99");
    expect(aircraftTypeLabel({})).toBeNull();
  });

  it("short form for one-line summaries", () => {
    expect(aircraftTypeLabel({ typeCode: "EC35" }, { short: true })).toBe("Airbus EC-135/635");
    expect(aircraftTypeLabel({ typeCode: "EC35" })).toBe("Airbus Helicopters EC-135/635");
  });
});

describe("aircraftTypeLine", () => {
  it("name · code, the bare code when unnamed, null without one", () => {
    expect(aircraftTypeLine("b738")).toBe("Boeing 737-800 · B738");
    expect(aircraftTypeLine("ZZ99")).toBe("ZZ99");
    expect(aircraftTypeLine(null)).toBeNull();
  });
});

describe("describeAircraftType", () => {
  it("says class, engines and wake in words", () => {
    expect(describeAircraftType(lookupAircraftType("EC35"))).toBe("Helicopter · 2 turbine engines · Light wake");
    expect(describeAircraftType(lookupAircraftType("B738"))).toBe("Aeroplane · 2 jet engines · Medium wake");
    expect(describeAircraftType(lookupAircraftType("DH8D"))).toBe("Aeroplane · 2 turboprop engines · Medium wake");
    expect(describeAircraftType(lookupAircraftType("C172"))).toBe("Aeroplane · 1 piston engine · Light wake");
    expect(describeAircraftType(lookupAircraftType("A388"))).toBe("Aeroplane · 4 jet engines · Heavy wake"); // the source has no J (super) entries
    expect(describeAircraftType(lookupAircraftType("V22"))).toBe("Tiltrotor · 2 turbine engines · Medium wake");
  });

  it("drops unknown parts and is null for nothing", () => {
    expect(describeAircraftType(lookupAircraftType("GLID"))).toBe("Aeroplane");
    expect(describeAircraftType(null)).toBeNull();
  });
});

describe("iconForAircraft", () => {
  it("lets a known type decide rotor vs wing over the emitter category", () => {
    expect(iconForAircraft({ cat: "A1", t: "EC35" })).toBe("helicopter"); // helicopter broadcasting A1
    expect(iconForAircraft({ cat: null, t: "R44" })).toBe("helicopter");
    expect(iconForAircraft({ cat: "A7", t: "B738" })).toBe("airplane"); // aeroplane broadcasting A7
    expect(iconForAircraft({ cat: "A3", t: "B738" })).toBe("airplane");
    expect(iconForAircraft({ cat: "B2", t: "BALL" })).toBe("airballoon");
    expect(iconForAircraft({ t: "DRON" })).toBe("quadcopter");
  });

  it("keeps the category icon for special categories and unknown types", () => {
    expect(iconForAircraft({ cat: "B6", t: "C172" })).toBe("quadcopter"); // a drone flagged by its category
    expect(iconForAircraft({ cat: "A7", t: "ZZ99" })).toBe("helicopter");
    expect(iconForAircraft({ cat: "A7" })).toBe("helicopter");
    expect(iconForAircraft({ cat: "B2" })).toBe("airballoon");
    expect(iconForAircraft({})).toBe("airplane");
  });
});
