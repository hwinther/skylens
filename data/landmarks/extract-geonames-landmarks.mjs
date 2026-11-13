#!/usr/bin/env node
// Build data/landmarks/landmarks.csv.gz, which the Docker image bakes in for GET /api/landmarks (the AR
// "what am I looking at?" identify feature), from GeoNames (CC BY 4.0, https://www.geonames.org):
//  - Peaks: mountains / peaks / hills (feature codes MT, PK, MTS, HLL) in Norway, Sweden and Finland.
//    GeoNames rarely carries a surveyed elevation for these, so the SRTM-derived `dem` column is the
//    fallback (an average over a ~90 m cell: it reads low on sharp summits). Only peaks that stand out
//    are kept: topographic isolation (distance to the nearest higher peak in the same set), computed here.
//  - Places: Norway's populated places (PPLC/PPLA/PPLA2/PPLA3/PPL/PPLL) from the country file, plus
//    cities1000 abroad (Nordic neighbours from 1 000 inhabitants, the rest of the world from 15 000).
//
// Run by hand when the data should be refreshed (not at build time: the image must not depend on the
// GeoNames dump being up), then commit the output. Download and unzip the source files first:
//   curl -O https://download.geonames.org/export/dump/{NO,SE,FI,cities1000}.zip   (then unzip each)
//   node data/landmarks/extract-geonames-landmarks.mjs --src <dir with NO.txt SE.txt FI.txt cities1000.txt>
// It also rewrites app/src/mock/demo-landmarks.json: a few dozen real features around the demo-mode
// observer (the recorded demo series' home, central Oslo), so identify works offline in demo mode.
//
// Output: semicolon-separated, one row per feature, sorted by id, no header:
//   id;kind;name;lat;lon;ele;pop;iso
// id      g<geonameid>
// kind    peak | city | town | village | hamlet
// name    GeoNames name (semicolons stripped)
// lat/lon 4 decimals (~10 m)
// ele     metres (peaks always; places only when GeoNames has a surveyed elevation), else empty
// pop     population when GeoNames has one (> 0), else empty
// iso     peaks: isolation in km (1 decimal, capped at ISOLATION_CAP_KM), else empty

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcArg = process.argv.indexOf("--src");
if (srcArg < 0 || !process.argv[srcArg + 1]) {
  console.error("usage: extract-geonames-landmarks.mjs --src <dir>");
  process.exit(2);
}
const SRC = process.argv[srcArg + 1];

/** Peak countries: the home region and its neighbours, whose mountains are visible across the border. */
const PEAK_COUNTRIES = ["NO", "SE", "FI"];
const PEAK_CODES = new Set(["MT", "PK", "MTS", "HLL"]);
/** A hill must be the highest point within this distance (in this dataset) to be kept. */
const MIN_ISOLATION_KM = 3;
/** Entries GeoNames classes as a mountain or peak (MT/PK/MTS) are kept from this isolation. */
const MIN_ISOLATION_MT_KM = 1.5;
/** Lower than this is dropped whatever the isolation (coastal knolls). */
const MIN_PEAK_ELE_M = 100;
const ISOLATION_CAP_KM = 100;

/** Norway's populated-place codes (historic / abandoned / sections of a place left out). */
const NO_PLACE_CODES = new Set(["PPLC", "PPLA", "PPLA2", "PPLA3", "PPL", "PPLL"]);
/** Abroad: cities1000 rows are kept from this population (Nordic neighbours lower, the rest higher). */
const NEAR_ABROAD = new Set(["SE", "FI", "DK"]);
const NEAR_ABROAD_MIN_POP = 1000;
const WORLD_MIN_POP = 15000;

/** Demo-mode sample centre: the recorded demo series' home (app/src/mock/recorded-aircraft.json). */
const DEMO_HOME = JSON.parse(
  readFileSync(path.join(here, "../../app/src/mock/recorded-aircraft.json"), "utf8"),
).home;

const clean = (s) => s.replace(/[;\r\n\t]+/g, " ").trim();
const num = (s) => (s === "" || s == null ? NaN : Number(s));

/** Tab-separated GeoNames rows. Columns: 0 id, 1 name, 4 lat, 5 lon, 6 class, 7 code, 8 country,
 *  14 population, 15 elevation, 16 dem. */
function* rows(file) {
  const text = readFileSync(path.join(SRC, file), "utf8");
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, "");
    start = end + 1;
    if (line) yield line.split("\t");
  }
}

function placeKind(code, pop) {
  if (code === "PPLC" || pop >= 50_000) return "city";
  if (code === "PPLA" || code === "PPLA2" || pop >= 2_000) return "town";
  if (code === "PPLL") return "hamlet";
  return "village";
}

function distKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// --- Peaks -------------------------------------------------------------------------------------------
const peaks = [];
for (const cc of PEAK_COUNTRIES) {
  for (const f of rows(`${cc}.txt`)) {
    if (f[6] !== "T" || !PEAK_CODES.has(f[7])) continue;
    const lat = num(f[4]);
    const lon = num(f[5]);
    const surveyed = num(f[15]);
    const dem = num(f[16]);
    const ele = Number.isFinite(surveyed) ? surveyed : dem > -1000 ? dem : NaN;
    const name = clean(f[1]);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(ele)) continue;
    peaks.push({ id: `g${f[0]}`, kind: "peak", code: f[7], name, lat, lon, ele: Math.round(ele) });
  }
}

// Isolation: distance to the nearest strictly higher peak (ties broken by id, so of two entries for one
// summit only one keeps its isolation). Brute force over a 0.5° lat x 1° lon bucket grid, widening the
// search until a higher peak is found or the cap is reached.
const LAT_CELL = 0.5;
const LON_CELL = 1;
const grid = new Map();
const cellOf = (p) => [Math.floor(p.lat / LAT_CELL), Math.floor(p.lon / LON_CELL)];
for (const p of peaks) {
  const [i, j] = cellOf(p);
  const k = `${i}:${j}`;
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(p);
}
const higher = (a, b) => a.ele > b.ele || (a.ele === b.ele && a.id < b.id);
for (const p of peaks) {
  const [i0, j0] = cellOf(p);
  let best = ISOLATION_CAP_KM;
  // A 0.5° lat cell is ~55 km; two rings cover the 100 km cap (lon cells are 1° wide, >= 0.5° lat here).
  for (let di = -2; di <= 2; di++) {
    for (let dj = -2; dj <= 2; dj++) {
      const cell = grid.get(`${i0 + di}:${j0 + dj}`);
      if (!cell) continue;
      for (const q of cell) {
        if (q === p || !higher(q, p)) continue;
        if (Math.abs(q.lat - p.lat) * 111 > best) continue;
        const d = distKm(p, q);
        if (d < best) best = d;
      }
    }
  }
  p.iso = best;
}
const keptPeaks = peaks.filter(
  (p) =>
    p.ele >= MIN_PEAK_ELE_M &&
    (p.iso >= MIN_ISOLATION_KM || (p.code !== "HLL" && p.iso >= MIN_ISOLATION_MT_KM)),
);

// --- Places ------------------------------------------------------------------------------------------
const places = [];
for (const f of rows("NO.txt")) {
  if (f[6] !== "P" || !NO_PLACE_CODES.has(f[7])) continue;
  const lat = num(f[4]);
  const lon = num(f[5]);
  const name = clean(f[1]);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const pop = num(f[14]) > 0 ? num(f[14]) : null;
  const ele = Number.isFinite(num(f[15])) ? Math.round(num(f[15])) : null;
  places.push({ id: `g${f[0]}`, kind: placeKind(f[7], pop ?? 0), name, lat, lon, ele, pop });
}
let abroad = 0;
for (const f of rows("cities1000.txt")) {
  const cc = f[8];
  if (cc === "NO") continue; // the country file above already has these (and the small ones)
  const pop = num(f[14]);
  if (!(pop >= (NEAR_ABROAD.has(cc) ? NEAR_ABROAD_MIN_POP : WORLD_MIN_POP))) continue;
  const lat = num(f[4]);
  const lon = num(f[5]);
  const name = clean(f[1]);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const ele = Number.isFinite(num(f[15])) ? Math.round(num(f[15])) : null;
  places.push({ id: `g${f[0]}`, kind: placeKind(f[7], pop), name, lat, lon, ele, pop });
  abroad++;
}

// --- Write -------------------------------------------------------------------------------------------
const all = [...keptPeaks, ...places].sort((a, b) => a.id.localeCompare(b.id));
const row = (p) =>
  [
    p.id,
    p.kind,
    p.name,
    p.lat.toFixed(4),
    p.lon.toFixed(4),
    p.ele ?? "",
    p.pop ?? "",
    p.kind === "peak" ? p.iso.toFixed(1) : "",
  ].join(";");
const csv = all.map(row).join("\n") + "\n";
const gz = gzipSync(Buffer.from(csv, "utf8"), { level: 9 });
const out = path.join(here, "landmarks.csv.gz");
writeFileSync(out, gz);

// --- Demo sample -------------------------------------------------------------------------------------
// The most prominent peaks within 150 km and the larger places within 40 km of the demo home: real
// GeoNames rows, so the demo shows the same names live mode would.
const near = (p, km) => distKm(DEMO_HOME, p) <= km;
const demoPeaks = keptPeaks
  .filter((p) => near(p, 150))
  .sort((a, b) => b.iso * Math.sqrt(b.ele) - a.iso * Math.sqrt(a.ele) || a.id.localeCompare(b.id))
  .slice(0, 40);
const demoPlaces = places
  .filter((p) => (p.kind === "city" || p.kind === "town") && near(p, 40))
  .sort((a, b) => (b.pop ?? 0) - (a.pop ?? 0) || a.id.localeCompare(b.id))
  .slice(0, 30);
const demo = [...demoPeaks, ...demoPlaces]
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((p) => ({
    id: p.id,
    kind: p.kind,
    name: p.name,
    lat: Number(p.lat.toFixed(4)),
    lon: Number(p.lon.toFixed(4)),
    elevationM: p.ele ?? null,
    population: p.pop ?? null,
    isolationKm: p.kind === "peak" ? Number(p.iso.toFixed(1)) : null,
  }));
const demoOut = path.join(here, "../../app/src/mock/demo-landmarks.json");
writeFileSync(demoOut, JSON.stringify(demo, null, 2) + "\n");

const counts = all.reduce((m, p) => ((m[p.kind] = (m[p.kind] ?? 0) + 1), m), {});
console.log(`peaks ${peaks.length} -> kept ${keptPeaks.length}; places ${places.length} (abroad ${abroad})`, counts);
console.log(`wrote ${out} (${gz.length} bytes, ${csv.length} raw)`);
console.log(`sha256 ${createHash("sha256").update(gz).digest("hex")}`);
console.log(`wrote ${demoOut} (${demo.length} features)`);
