/**
 * The cockpit view's 3D models: which class each followed object gets (src/sim/modelClass.ts), how it is
 * sized, placed and turned (src/sim/models.ts, the tracker's bank, the chase distance), and that the baked
 * files, the in-app credits and the provenance file stay in step.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { chaseSpec, CHASE_FRAME_LENGTHS, CHASE_MODEL_LENGTHS, MIN_CHASE_DISTANCE_M } from "@/sim/chase";
import { aircraftModelClass, simModelClass, vesselModelClass } from "@/sim/modelClass";
import { MODEL_CHANGES_NOTE, MODEL_CREDITS, modelCreditLine, modelCreditsSummary } from "@/sim/modelCredits";
import {
  drawnExtentM,
  isSimModelClass,
  MAX_MODEL_PITCH_DEG,
  MIN_DRAWN_EXTENT_M,
  modelAttitude,
  modelBaseUrl,
  modelHeightM,
  modelScale,
  modelUrl,
  propellerAngle,
  SIM_MODEL_CLASSES,
  SIM_MODELS,
} from "@/sim/models";
import { bankForTurn, MAX_BANK_DEG, type SimSample } from "@/sim/simPose";
import { SimTracker } from "@/sim/tracker";

const MODELS_DIR = path.join(__dirname, "..", "public", "models", "sim");

describe("aircraft model class", () => {
  it.each([
    // Designator from the bundled type table first.
    ["B738", "A3", "airliner"],
    ["A320", null, "airliner"],
    ["E190", null, "airliner"],
    ["B722", null, "airliner"], // three-engine medium jet
    ["B744", null, "widebody"], // four engines, heavy
    ["B789", null, "widebody"], // heavy twin
    ["A388", null, "widebody"],
    ["C25B", null, "bizjet"], // light jet
    ["GLF6", null, "bizjet"], // medium jet named like a business jet
    ["FA7X", null, "bizjet"], // three-engine Falcon
    ["CL60", null, "bizjet"],
    ["E55P", null, "bizjet"],
    ["DH8D", "A2", "turboprop"],
    ["AT76", null, "turboprop"],
    ["C130", null, "turboprop"], // four turboprops
    ["DHC6", null, "twin-prop"], // light turboprop twin
    ["BE20", null, "turboprop"], // King Air 200: medium wake in the table
    ["BN2P", null, "twin-prop"], // piston twin
    ["C172", "A7", "light-single"], // the type wins over a wrong category
    ["PC12", null, "light-single"], // single turboprop
    ["GLID", null, "light-single"],
    ["EC35", "A3", "helicopter"],
    ["S92", null, "helicopter"],
    ["V22", null, "turboprop"], // tiltrotor
    ["BALL", null, null], // a balloon keeps the marker
  ])("%s (cat %s) → %s", (t, cat, expected) => {
    expect(aircraftModelClass({ t, cat })).toBe(expected);
  });

  it.each([
    ["A1", "light-single"],
    ["A2", "turboprop"],
    ["A3", "airliner"],
    ["A4", "airliner"],
    ["A5", "widebody"],
    ["A6", "bizjet"],
    ["A7", "helicopter"],
    ["B1", "light-single"],
    ["B2", null],
    ["B6", "light-single"],
    ["C1", null],
    ["a7", "helicopter"],
  ])("falls back to the emitter category %s → %s", (cat, expected) => {
    expect(aircraftModelClass({ t: "ZZZ9", cat })).toBe(expected);
    expect(aircraftModelClass({ cat })).toBe(expected);
  });

  it("falls back to the narrow-body jet with nothing known", () => {
    expect(aircraftModelClass({})).toBe("airliner");
    expect(aircraftModelClass({ t: "", cat: "" })).toBe("airliner");
    expect(aircraftModelClass({ cat: "A0" })).toBe("airliner");
  });
});

describe("vessel model class", () => {
  it.each([
    [70, "cargo-ship"],
    [79, "cargo-ship"],
    [80, "cargo-ship"], // tanker
    [60, "ferry"],
    [69, "ferry"],
    [40, "ferry"], // high-speed craft
    [30, "small-boat"], // fishing
    [36, "small-boat"], // sailing
    [37, "small-boat"], // pleasure craft
    [52, "small-boat"], // tug
    [0, "small-boat"],
    [null, "small-boat"],
  ])("AIS ship type %s → %s", (shipType, expected) => {
    expect(vesselModelClass({ kind: "ship", shipType })).toBe(expected);
  });

  it("gives an aid to navigation none", () => {
    expect(vesselModelClass({ kind: "aton", shipType: 70 })).toBeNull();
  });

  it("dispatches by what is followed; satellites always get the satellite", () => {
    expect(simModelClass("satellite", null)).toBe("satellite");
    expect(simModelClass("aircraft", { t: "B744" })).toBe("widebody");
    expect(simModelClass("vessel", { kind: "ship", shipType: 61 })).toBe("ferry");
    expect(simModelClass("aircraft", null)).toBe("airliner");
  });
});

describe("model files and URLs", () => {
  it("serves from /models/sim/ on the web and next to the DOM page in the APK", () => {
    expect(modelBaseUrl(undefined)).toBe("/models/sim/");
    expect(modelBaseUrl("")).toBe("/models/sim/");
    expect(modelBaseUrl("./")).toBe("./models/sim/");
    expect(modelBaseUrl("/skylens")).toBe("/skylens/models/sim/");
    expect(modelUrl("/models/sim/", "ferry")).toBe("/models/sim/ferry.glb");
    expect(modelUrl("https://cdn.example/m", "satellite")).toBe("https://cdn.example/m/satellite.glb");
  });

  it("knows its classes", () => {
    expect(isSimModelClass("airliner")).toBe(true);
    expect(isSimModelClass("toString")).toBe(false);
    expect(isSimModelClass(null)).toBe(false);
  });

  it("bakes exactly one file per class, each a glTF 2.0 GLB Cesium decodes without extra decoders", () => {
    const files = readdirSync(MODELS_DIR).filter((f) => f.endsWith(".glb")).sort();
    expect(files).toEqual(SIM_MODEL_CLASSES.map((c) => SIM_MODELS[c].file).sort());
    let total = 0;
    for (const file of files) {
      const buf = readFileSync(path.join(MODELS_DIR, file));
      total += buf.length;
      expect(buf.toString("ascii", 0, 4)).toBe("glTF");
      expect(buf.readUInt32LE(4)).toBe(2);
      expect(buf.readUInt32LE(8)).toBe(buf.length);
      // First chunk: the JSON. Only extensions Cesium's own build handles (meshopt is embedded in it).
      const jsonLength = buf.readUInt32LE(12);
      expect(buf.toString("ascii", 16, 20)).toBe("JSON");
      const gltf = JSON.parse(buf.toString("utf8", 20, 20 + jsonLength)) as { extensionsRequired?: string[] };
      for (const ext of gltf.extensionsRequired ?? []) {
        expect(["EXT_meshopt_compression", "KHR_mesh_quantization"]).toContain(ext);
      }
      expect(buf.length).toBeLessThan(60_000);
    }
    // Baked into public/ (web export + APK): keep the set small.
    expect(total).toBeLessThan(350_000);
  });

  it("keeps the named propeller node in the light single's file", () => {
    const buf = readFileSync(path.join(MODELS_DIR, SIM_MODELS["light-single"].file));
    const json = buf.toString("utf8", 20, 20 + buf.readUInt32LE(12));
    expect(json).toContain(`"name":"${SIM_MODELS["light-single"].propellerNode}"`);
  });
});

describe("model size and placement", () => {
  it("draws small craft larger than life, never anything smaller", () => {
    expect(modelScale("airliner", "aircraft")).toBe(1);
    expect(modelScale("widebody", "aircraft")).toBe(1);
    expect(drawnExtentM("light-single", "aircraft")).toBeCloseTo(MIN_DRAWN_EXTENT_M.aircraft, 6);
    expect(drawnExtentM("helicopter", "aircraft")).toBeCloseTo(MIN_DRAWN_EXTENT_M.aircraft, 6);
    expect(drawnExtentM("small-boat", "vessel")).toBeCloseTo(MIN_DRAWN_EXTENT_M.vessel, 6);
    expect(modelScale("cargo-ship", "vessel")).toBe(1);
    expect(drawnExtentM("satellite", "satellite")).toBeCloseTo(MIN_DRAWN_EXTENT_M.satellite, 6);
    for (const c of SIM_MODEL_CLASSES) expect(modelScale(c, "aircraft")).toBeGreaterThanOrEqual(1);
  });

  it("stands aircraft on their wheels at the pose and satellites at their altitude", () => {
    expect(modelHeightM("airliner", "aircraft", 1000, 200)).toBeCloseTo(1000 + SIM_MODELS.airliner.heightM / 2, 6);
    const s = modelScale("light-single", "aircraft");
    expect(modelHeightM("light-single", "aircraft", 50, 48)).toBeCloseTo(50 + (SIM_MODELS["light-single"].heightM / 2) * s, 6);
    expect(modelHeightM("satellite", "satellite", 420_000, undefined)).toBe(420_000);
  });

  it("floats ships on the water whatever the camera's eye height", () => {
    // The vessel pose sits at the bridge (12 m); the model's waterline goes on the surface below.
    expect(modelHeightM("cargo-ship", "vessel", 12, undefined)).toBe(24);
    expect(modelHeightM("cargo-ship", "vessel", 12, -35)).toBe(24); // bathymetry → sea level
    expect(modelHeightM("ferry", "vessel", 12, 100)).toBe(112); // a lake at 100 m
    const s = modelScale("small-boat", "vessel");
    expect(modelHeightM("small-boat", "vessel", 12, 0)).toBeCloseTo(0.35 * s, 6);
  });

  it("turns the nose along the track (Cesium heading 0 = east) and only tilts aircraft", () => {
    expect(modelAttitude({ headingDeg: 90 }, "aircraft")).toEqual({ headingDeg: 0, pitchDeg: 0, rollDeg: 0 });
    expect(modelAttitude({ headingDeg: 0, pathPitchDeg: 4, bankDeg: 20 }, "aircraft")).toEqual({
      headingDeg: -90,
      pitchDeg: 4,
      rollDeg: 20,
    });
    expect(modelAttitude({ headingDeg: 0, pathPitchDeg: 40 }, "aircraft").pitchDeg).toBe(MAX_MODEL_PITCH_DEG);
    expect(modelAttitude({ headingDeg: 0, pathPitchDeg: -40 }, "aircraft").pitchDeg).toBe(-MAX_MODEL_PITCH_DEG);
    expect(modelAttitude({ headingDeg: 180, pathPitchDeg: 5, bankDeg: 10 }, "vessel")).toEqual({
      headingDeg: 90,
      pitchDeg: 0,
      rollDeg: 0,
    });
    expect(modelAttitude({ headingDeg: 0, pathPitchDeg: Number.NaN }, "aircraft").pitchDeg).toBe(0);
  });

  it("reuses the attitude object it is given", () => {
    const out = { headingDeg: 1, pitchDeg: 2, rollDeg: 3 };
    expect(modelAttitude({ headingDeg: 270 }, "satellite", out)).toBe(out);
    expect(out).toEqual({ headingDeg: 180, pitchDeg: 0, rollDeg: 0 });
  });

  it("spins the propeller at a steady visible rate", () => {
    expect(propellerAngle(0)).toBe(0);
    expect(propellerAngle(1000 / 16)).toBeCloseTo(Math.PI / 2, 6); // a quarter turn at 4 turns/s
    expect(propellerAngle(10_000)).toBeLessThan(2 * Math.PI);
  });
});

describe("chase distance around the model", () => {
  it("keeps the kind's base distance without a model", () => {
    expect(chaseSpec("vessel", null)).toEqual(chaseSpec("vessel"));
    expect(chaseSpec("aircraft", 0)).toEqual(chaseSpec("aircraft"));
  });

  it("frames small craft closer, never past the base distance or under the minimum", () => {
    const base = chaseSpec("aircraft").distanceM;
    expect(chaseSpec("aircraft", drawnExtentM("airliner", "aircraft")).distanceM).toBe(38 * CHASE_FRAME_LENGTHS);
    expect(chaseSpec("aircraft", drawnExtentM("helicopter", "aircraft")).distanceM).toBe(24 * CHASE_FRAME_LENGTHS);
    expect(chaseSpec("aircraft", drawnExtentM("widebody", "aircraft")).distanceM).toBe(base);
    expect(chaseSpec("aircraft", 5).distanceM).toBe(MIN_CHASE_DISTANCE_M.aircraft);
    expect(chaseSpec("vessel", drawnExtentM("small-boat", "vessel")).distanceM).toBe(16 * CHASE_FRAME_LENGTHS);
    expect(chaseSpec("satellite", drawnExtentM("satellite", "satellite"))).toEqual(chaseSpec("satellite"));
    expect(chaseSpec("aircraft", 24).elevationDeg).toBe(chaseSpec("aircraft").elevationDeg);
  });

  it("stands back from a long ship", () => {
    expect(chaseSpec("vessel", drawnExtentM("cargo-ship", "vessel")).distanceM).toBe(200 * CHASE_MODEL_LENGTHS);
    expect(chaseSpec("vessel", drawnExtentM("ferry", "vessel")).distanceM).toBe(120 * CHASE_MODEL_LENGTHS);
  });
});

describe("bank into turns", () => {
  it("follows a coordinated turn, right turn = right wing down", () => {
    // Rate-one turn (3°/s) at 120 m/s: tan(bank) = 120 · 0.0524 / 9.81 → ~32.6°, clamped.
    expect(bankForTurn(120, 3)).toBe(MAX_BANK_DEG);
    expect(bankForTurn(60, 3)).toBeCloseTo(17.8, 1);
    expect(bankForTurn(60, -3)).toBeCloseTo(-17.8, 1);
    expect(bankForTurn(60, 0)).toBe(0);
  });

  it("stays level when slow (taxiing, hovering) or unknown", () => {
    expect(bankForTurn(10, 10)).toBe(0);
    expect(bankForTurn(Number.NaN, 3)).toBe(0);
    expect(bankForTurn(100, Number.POSITIVE_INFINITY)).toBe(0);
  });

  const T0 = 1_800_000_000_000;
  const sample = (over: Partial<SimSample> = {}): SimSample => ({
    kind: "aircraft",
    lat: 60,
    lon: 10,
    altM: 3000,
    speedMps: 60,
    headingDeg: 0,
    vertMps: 0,
    basePitchDeg: -6,
    timeMs: T0,
    ...over,
  });

  /**
   * Fly a steady turn at `rateDegS` for `seconds`, one sample per second, posing at 20 fps; the bank of
   * every frame in the last two seconds.
   */
  function fly(rateDegS: number, seconds: number, kind: SimSample["kind"] = "aircraft"): number[] {
    const t = new SimTracker();
    const banks: number[] = [];
    for (let ms = 0; ms <= seconds * 1000; ms += 50) {
      if (ms % 1000 === 0) {
        t.update(sample({ kind, headingDeg: ((((rateDegS * ms) / 1000) % 360) + 360) % 360, timeMs: T0 + ms }), T0 + ms);
      }
      const bank = t.pose(T0 + ms)!.bankDeg ?? Number.NaN;
      if (ms > (seconds - 2) * 1000) banks.push(bank);
    }
    return banks;
  }

  it("banks smoothly into a steady turn and levels out flying straight", () => {
    const expected = bankForTurn(60, 3); // ~17.8°
    const right = fly(3, 15);
    // Close to the coordinated bank, with only a small ripple from the 1 Hz samples.
    for (const b of right) expect(Math.abs(b - expected)).toBeLessThan(1.5);
    expect(Math.max(...right) - Math.min(...right)).toBeLessThan(2);
    for (const b of fly(-3, 15)) expect(Math.abs(b + expected)).toBeLessThan(1.5);
    for (const b of fly(0, 15)) expect(b).toBe(0);
  });

  it("never banks a ship", () => {
    for (const b of fly(3, 15, "vessel")) expect(b).toBe(0);
  });

  it("reports the flight path without the camera's base pitch", () => {
    const t = new SimTracker();
    t.update(sample({ speedMps: 100, vertMps: 10 }), T0);
    const p = t.pose(T0)!;
    expect(p.pitchDeg).toBeCloseTo(-6 + 5.71, 1);
    expect(p.pathPitchDeg).toBeCloseTo(5.71, 1);
  });
});

describe("model credits", () => {
  const attribution = readFileSync(path.join(MODELS_DIR, "ATTRIBUTION.md"), "utf8");

  it("credits every class once, with a licence and source link", () => {
    expect(MODEL_CREDITS.map((c) => c.cls).sort()).toEqual([...SIM_MODEL_CLASSES].sort());
    for (const c of MODEL_CREDITS) {
      expect(c.title).not.toBe("");
      expect(c.author).not.toBe("");
      expect(c.sourceUrl).toMatch(/^https:\/\//);
      expect(c.licenceUrl).toMatch(/^https:\/\/creativecommons\.org\//);
    }
  });

  it("matches the provenance file next to the models", () => {
    for (const c of MODEL_CREDITS) {
      expect(attribution).toContain(`\`${SIM_MODELS[c.cls].file}\``);
      expect(attribution).toContain(c.sourceUrl);
      expect(attribution).toContain(modelCreditLine(c).replace(" (https://creativecommons.org/publicdomain/zero/1.0/)", ""));
    }
  });

  it("uses Poly Pizza's credit form and says the models were changed", () => {
    expect(modelCreditLine(MODEL_CREDITS[0])).toBe(
      "Airplane by jeremy [CC-BY] (https://creativecommons.org/licenses/by/3.0/) via Poly Pizza (https://poly.pizza/m/9Ev6pklkSYp)",
    );
    expect(modelCreditsSummary()).toBe("11 models · CC BY 3.0 / CC0");
    expect(MODEL_CHANGES_NOTE).toMatch(/modified/i);
  });
});
