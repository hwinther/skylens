#!/usr/bin/env node
// Build app/src/aircraft/aircraft-types.json: the ICAO type designator table (ICAO Doc 8643 style) the app
// bundles to turn the `t` it gets per aircraft ("B738", "EC35") into a readable name ("Boeing 737-800"),
// an aircraft class ("Helicopter · 2 turbine engines · Light wake") and the aeroplane-vs-helicopter icon,
// with no network call (works in demo mode too).
//
// Source: the Mictronics aircraft database (https://github.com/Mictronics/aircraft-database), file
// types.json inside indexedDB.zip, PINNED to one git commit and verified by SHA-256 (a swapped upstream
// file fails the build). It is the same data tar1090-db copies to db/icao_aircraft_types2.js (and the
// names tar1090-db writes into the aircraft.csv.gz the backend bakes), but Mictronics publishes it with a
// stable history, where tar1090-db force-pushes its database commit.
//
// Licence: Open Data Commons Attribution License (ODC-By 1.0,
// https://opendatacommons.org/licenses/by/1-0/). The output carries the notice and the licence URI, and
// the app shows "Contains information from the Mictronics aircraft database (ODC-By)" wherever the
// names or classes appear.
//
// Run by hand when the table should be refreshed (not at build time), then commit the output:
//   node data/aircraft-types/build-aircraft-types.mjs                    (downloads ~3.4 MB)
//   node data/aircraft-types/build-aircraft-types.mjs --zip indexedDB.zip   (a local copy, same checksum)
// To move to a newer database: bump COMMIT and SHA256 below (the script prints the new hash on mismatch).
//
// Output: JSON { source, url, license, version, types }. `types` maps each designator to one string:
//   chars 0-2  ICAO description: class (L landplane, S seaplane, A amphibian, H helicopter, G gyrocopter,
//              T/R tiltrotor, B lighter-than-air, D drone, P parachutist), engine count (0-8, or C),
//              engine type (P piston, T turboprop/turboshaft, J jet, E electric, R rocket, - none);
//   char  3    wake turbulence category (L light, M medium, H heavy, J super, - none);
//   chars 4-   manufacturer + model as published ("BOEING 737-800"), may be empty.
// The app's src/aircraft/aircraftType.ts parses it.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const COMMIT = "479e4d016c596214c8ab853d8fdf3175ce6739d3"; // 2026-11-08 "Update aircraft database."
const URL = `https://raw.githubusercontent.com/Mictronics/aircraft-database/${COMMIT}/indexedDB.zip`;
const SHA256 = "fd9bd2d7fd27d9a52f32abbb7751a4f9f66bc1744bbd5a14797b95c945094ae0";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "../../app/src/aircraft/aircraft-types.json");

/** Ground objects and "no type" placeholders: not aircraft, so not in the table. */
const SKIP = new Set(["ZZZZ", "GND", "EMER", "SERV", "TWR"]);

/** Placeholder designators the source leaves unnamed. */
const PSEUDO_NAMES = {
  BALL: "Balloon",
  SHIP: "Airship",
  DRON: "Drone",
  GYRO: "Gyrocopter",
  UHEL: "Helicopter",
  ULAC: "Ultralight",
  PARA: "Parachutist",
};

const zipArg = process.argv.indexOf("--zip");
const ZIP_PATH = zipArg > 0 ? process.argv[zipArg + 1] : null;

async function loadZip() {
  if (ZIP_PATH) return readFileSync(ZIP_PATH);
  const res = await fetch(URL, { headers: { "User-Agent": "skylens-aircraft-types/1.0" } });
  if (!res.ok) throw new Error(`GET ${URL}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** One file out of a zip archive (stored or deflated), via the central directory. */
function unzipEntry(zip, wanted) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory)");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === wanted) {
      if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error("corrupt local header");
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`${wanted}: unsupported compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wanted} not found in the zip`);
}

const zip = await loadZip();
const sha = createHash("sha256").update(zip).digest("hex");
if (sha !== SHA256) {
  console.error(`checksum mismatch: expected ${SHA256}, got ${sha}`);
  process.exit(1);
}

const raw = JSON.parse(unzipEntry(zip, "types.json").toString("utf8"));
const version = JSON.parse(unzipEntry(zip, "dbversion.json").toString("utf8")).version ?? null;

const types = {};
let skipped = 0;
for (const code of Object.keys(raw).sort()) {
  const [name, desc, wtc] = raw[code];
  if (SKIP.has(code) || typeof desc !== "string" || desc.length !== 3 || !/^[A-Z0-9]{2,4}$/.test(code)) {
    skipped++;
    continue;
  }
  const w = typeof wtc === "string" && /^[LMHJ]$/.test(wtc) ? wtc : "-";
  const label = (name || PSEUDO_NAMES[code] || "").trim().replace(/\s+/g, " ");
  types[code] = `${desc}${w}${label}`;
}

const out = {
  source: `Mictronics aircraft database, types.json (database version ${version}, commit ${COMMIT.slice(0, 12)})`,
  url: "https://github.com/Mictronics/aircraft-database",
  license:
    "Contains information from the Mictronics aircraft database, made available under the ODC Attribution License (ODC-By 1.0): https://opendatacommons.org/licenses/by/1-0/",
  version,
  types,
};

// One designator per line, so a refresh diffs readably.
const body = Object.entries(types)
  .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
  .join(",\n");
const head = JSON.stringify({ ...out, types: undefined }, null, 2).replace(/\n}$/, "");
writeFileSync(OUT, `${head},\n  "types": {\n${body}\n  }\n}\n`);
console.log(`wrote ${Object.keys(types).length} types (${skipped} skipped) to ${path.relative(process.cwd(), OUT)}`);
