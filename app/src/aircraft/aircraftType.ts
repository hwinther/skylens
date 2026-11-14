/**
 * ICAO aircraft type designators ("B738", "EC35") → readable name, class and wake category, from the
 * bundled table `aircraft-types.json` (built by data/aircraft-types/build-aircraft-types.mjs from the
 * Mictronics aircraft database, ODC-By: show AIRCRAFT_TYPES_ATTRIBUTION wherever a name or class from
 * it appears). Pure TS and local, so it works in demo and live mode with no network call.
 *
 * The designator reaches the app as the hub DTO's `t` (offline registry on the backend, or the away-mode
 * aggregator's own field) and as `metadata.typeCode` in the detail response.
 */

import table from "./aircraft-types.json";

const TYPES: Readonly<Record<string, string>> = (table as { types: Record<string, string> }).types;

/** The credit ODC-By asks for, shown next to names / classes from the table. */
export const AIRCRAFT_TYPES_ATTRIBUTION = "Type data: Mictronics aircraft database (ODC-By)";

/** ICAO description, first letter. The source uses R for tiltrotors where ICAO Doc 8643 writes T. */
export type AircraftClass =
  | "landplane"
  | "seaplane"
  | "amphibian"
  | "helicopter"
  | "gyrocopter"
  | "tiltrotor"
  | "lighter-than-air"
  | "drone"
  | "parachutist";

export type EngineType = "piston" | "turbine" | "jet" | "electric" | "rocket";

export type WakeCategory = "light" | "medium" | "heavy" | "super";

export interface AircraftTypeInfo {
  /** Upper-case designator, e.g. "EC35". */
  code: string;
  /** Readable manufacturer + model ("Airbus Helicopters EC-135/635"), or null when the table has none. */
  name: string | null;
  /** The ICAO description as published, e.g. "H2T". */
  description: string;
  cls: AircraftClass | null;
  /** Engine count; null when unknown or not applicable (gliders, balloons). */
  engines: number | null;
  engineType: EngineType | null;
  wake: WakeCategory | null;
}

const CLASS: Record<string, AircraftClass> = {
  L: "landplane",
  S: "seaplane",
  A: "amphibian",
  H: "helicopter",
  G: "gyrocopter",
  T: "tiltrotor",
  R: "tiltrotor",
  B: "lighter-than-air",
  D: "drone",
  P: "parachutist",
};

const ENGINE: Record<string, EngineType> = { P: "piston", T: "turbine", J: "jet", E: "electric", R: "rocket" };

const WAKE: Record<string, WakeCategory> = { L: "light", M: "medium", H: "heavy", J: "super" };

/** Look a designator up in the bundled table; null for unknown or blank codes. */
export function lookupAircraftType(code: string | null | undefined): AircraftTypeInfo | null {
  const key = code?.trim().toUpperCase();
  if (!key) return null;
  const entry = TYPES[key];
  if (!entry) return null;
  const description = entry.slice(0, 3);
  const count = description[1];
  const name = entry.slice(4).trim();
  return {
    code: key,
    name: name ? prettyTypeName(name) : null,
    description,
    cls: CLASS[description[0]] ?? null,
    engines: count >= "1" && count <= "9" ? Number(count) : null,
    engineType: ENGINE[description[2]] ?? null,
    wake: WAKE[entry[3]] ?? null,
  };
}

/** Rotor-borne (helicopter or gyrocopter) per the table; null when the designator is unknown. */
export function isRotorcraftType(code: string | null | undefined): boolean | null {
  const info = lookupAircraftType(code);
  if (!info?.cls) return null;
  return info.cls === "helicopter" || info.cls === "gyrocopter";
}

/** All-caps short words that are names, not acronyms ("DE HAVILLAND", "AIR TRACTOR", "MIL"). */
const SHORT_WORDS = new Set(["AIR", "MIL", "DE", "LA", "LE", "NEW", "FLY", "SKY", "SUD", "THE", "AND", "OF"]);

/** All-caps words of four or more letters that are acronyms and stay upper case. */
const ACRONYMS = new Set([
  "AASI", "ACBA", "AIDC", "AIDX", "AISA", "ALMS", "AMAX", "AMAY", "ATAC", "ATEC", "CASA", "CATA",
  "CVUT", "FAMA", "FLSZ", "HESA", "IPAI", "IRIAF", "ISAE", "ITBA", "KARI", "MAPO", "MVEN", "OMAC",
  "RTAF", "SGAU", "TLAC", "UNIS", "VSTOL", "VTOL",
]);

const isCapsWord = (w: string) => /^[A-Z][A-Z&.'/-]*$/.test(w);

function titlePart(part: string): string {
  const letters = part.replace(/[^A-Z]/g, "").length;
  if (ACRONYMS.has(part)) return part;
  if (letters < 4 && !SHORT_WORDS.has(part)) return part;
  if (/^MC[A-Z]{3,}$/.test(part)) return `Mc${part[2]}${part.slice(3).toLowerCase()}`;
  return part[0] + part.slice(1).toLowerCase();
}

/**
 * The source writes the manufacturer in capitals ("BOEING 737-800", "AIRBUS HELICOPTERS EC-135/635"):
 * title-case those leading words ("Boeing 737-800", "Airbus Helicopters EC-135/635"), keeping short
 * acronyms (BAE, PZL, IAI) and the model itself as written. Names already in mixed case pass unchanged.
 */
export function prettyTypeName(name: string): string {
  const words = name.trim().split(/\s+/);
  const maker = makerWordCount(words);
  return words.map((w, i) => (i < maker ? w.split("-").map(titlePart).join("-") : w)).join(" ");
}

/** Leading all-caps words (the manufacturer), never the last word (that is the model). */
function makerWordCount(words: string[]): number {
  let n = 0;
  while (n < words.length - 1 && isCapsWord(words[n])) n++;
  return n;
}

/** Names up to this long are short enough for the one-line card summary as they are. */
const SHORT_NAME_MAX = 22;

/**
 * A shorter form for the one-line card summary: a long name keeps only the manufacturer's first word
 * ("AIRBUS HELICOPTERS EC-135/635" → "Airbus EC-135/635"), two when the first is a particle ("De
 * Havilland"), and drops a model word that repeats it ("HAWKER BEECHCRAFT Hawker 750/850" → "Hawker
 * 750/850"). Short and mixed-case names come back as prettyTypeName gives them.
 */
export function shortTypeName(name: string): string {
  const pretty = prettyTypeName(name);
  if (pretty.length <= SHORT_NAME_MAX) return pretty;
  const words = pretty.split(" ");
  const maker = makerWordCount(name.trim().split(/\s+/));
  const keep = Math.min(maker, SHORT_WORDS.has(words[0].toUpperCase()) ? 2 : 1);
  if (maker <= keep) return pretty;
  const model = words.slice(maker);
  const last = words[keep - 1];
  if (model.length > 1 && model[0].toLowerCase() === last.toLowerCase()) model.shift();
  return [...words.slice(0, keep), ...model].join(" ");
}

/**
 * The best readable type for an aircraft: the per-airframe name from its metadata when known, else the
 * table's name for its designator, else the bare designator; null when nothing is known. `short` gives
 * the shortTypeName form for one-line summaries.
 */
export function aircraftTypeLabel(
  i: { typeName?: string | null; typeCode?: string | null },
  opts: { short?: boolean } = {},
): string | null {
  const format = opts.short ? shortTypeName : prettyTypeName;
  const own = i.typeName?.trim();
  if (own) return format(own);
  const code = i.typeCode?.trim().toUpperCase();
  if (!code) return null;
  const raw = TYPES[code]?.slice(4).trim();
  return raw ? format(raw) : code;
}

const CLASS_WORDS: Record<AircraftClass, string> = {
  landplane: "Aeroplane",
  seaplane: "Seaplane",
  amphibian: "Amphibian",
  helicopter: "Helicopter",
  gyrocopter: "Gyrocopter",
  tiltrotor: "Tiltrotor",
  "lighter-than-air": "Lighter than air",
  drone: "Drone",
  parachutist: "Parachutist",
};

const ROTOR: ReadonlySet<AircraftClass> = new Set(["helicopter", "gyrocopter", "tiltrotor"]);

function engineWords(info: AircraftTypeInfo): string | null {
  if (!info.engineType) return null;
  // A turbine drives a propeller on an aeroplane (turboprop) and a rotor on a rotorcraft (turboshaft).
  const kind =
    info.engineType === "turbine" ? (info.cls && ROTOR.has(info.cls) ? "turbine" : "turboprop") : info.engineType;
  if (info.engines == null) return `${kind[0].toUpperCase()}${kind.slice(1)} engines`;
  return `${info.engines} ${kind} engine${info.engines === 1 ? "" : "s"}`;
}

/** e.g. "Helicopter · 2 turbine engines · Light wake", "Aeroplane · 2 jet engines · Medium wake"; null when unknown. */
export function describeAircraftType(info: AircraftTypeInfo | null): string | null {
  if (!info) return null;
  const parts = [
    info.cls ? CLASS_WORDS[info.cls] : null,
    engineWords(info),
    info.wake ? `${info.wake[0].toUpperCase()}${info.wake.slice(1)} wake` : null,
  ].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * A compact list line for a designator: "Boeing 737-800 · B738" when the table names it, else just the
 * code ("ZZZ1"); null without a designator.
 */
export function aircraftTypeLine(code: string | null | undefined): string | null {
  const key = code?.trim().toUpperCase();
  if (!key) return null;
  const name = lookupAircraftType(key)?.name;
  return name ? `${name} · ${key}` : key;
}
