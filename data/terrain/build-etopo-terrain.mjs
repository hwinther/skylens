#!/usr/bin/env node
// Build data/terrain/terrain.bin.gz, which the Docker image bakes in for GET /api/terrain (the tiltable
// Radar's simplified relief), from ETOPO 2022 (NOAA NCEI, 15 arc-second global relief model; a US
// Government work, free to use and redistribute — credit "ETOPO 2022 (NOAA NCEI)").
//
// Downloaded at BUILD time only, as a few bounded, strided subsets from NOAA's public ERDDAP server
// (netCDF-3 responses; the raw files go to --cache and are never committed). Two point-sampled grids:
//  - "nordic": 54–71.5° N, 4–32° E every 30″ of latitude × 1′ of longitude (~0.9 × 0.5–1.1 km), the
//    home region (Norway, Sweden, Finland, Denmark), detailed enough for the radar's 25–500 km ranges;
//  - "world":  the whole globe every 10′ (~18 km), a coarse fallback so the relief shows anywhere.
// Run by hand when the data should be refreshed, then commit the output:
//   node data/terrain/build-etopo-terrain.mjs --cache <empty scratch dir>   (~25 MB downloaded)
//   node data/terrain/build-etopo-terrain.mjs --cache <dir> --offline       (rebuild from that cache)
// It also rewrites app/src/mock/demo-terrain.json: the radar grid around the demo-mode observer (the
// recorded demo series' home, central Oslo), sampled exactly like the endpoint does, so demo mode shows
// real relief with no API.
//
// Output (gzip of, little-endian):
//   "SKYTERR1"                                  magic, 8 ASCII bytes
//   u8   grid count, finest first
//   per grid: f64 south, f64 west (centre of the first cell), f64 dLat, f64 dLon (degrees),
//             u32 rows, u32 cols, then rows × cols u8 codes, row 0 southernmost, west → east.
// Each code byte is stored as the difference (mod 256) to the code in the row below (PNG "up" filter),
// which gzips noticeably smaller. Codes: 0 = sea (ETOPO ≤ 0 m), 1–200 = c × 10 m, 201–255 =
// 2000 + (c − 200) × 125 m (coarse above 2 000 m, still reaching Everest).

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const CACHE = arg("--cache");
const OFFLINE = process.argv.includes("--offline");
if (!CACHE) {
  console.error("usage: build-etopo-terrain.mjs --cache <dir> [--offline]");
  process.exit(2);
}
mkdirSync(CACHE, { recursive: true });

const ERDDAP = "https://coastwatch.pfeg.noaa.gov/erddap/griddap/ETOPO_2022_v1_15s.nc";
// 15″ source cells; the strides keep every n-th one. Latitude bands keep each request around 5 MB; each
// band after the first starts one stride after the previous band's last row, so the rows stay evenly spaced.
const GRIDS = [
  {
    name: "nordic",
    bands: [54.0, 59.8, 65.6, 71.5],
    lon: [4.0, 32.0],
    latStride: 2,
    lonStride: 4,
  },
  {
    name: "world",
    bands: [-89.99, 0, 89.99],
    lon: [-179.99, 179.99],
    latStride: 40,
    lonStride: 40,
  },
];

const UA = "terrain-grid-builder/1.0";
/** ETOPO 2022 15″ cell size in degrees. */
const SOURCE_STEP_DEG = 1 / 240;

async function fetchBand(grid, idx, s, n) {
  const file = path.join(CACHE, `${grid.name}-${idx}-${s.toFixed(5)}.nc`);
  if (existsSync(file)) return readFileSync(file);
  if (OFFLINE) throw new Error(`missing ${file} (--offline)`);
  const q = `z[(${s}):${grid.latStride}:(${n})][(${grid.lon[0]}):${grid.lonStride}:(${grid.lon[1]})]`;
  const url = `${ERDDAP}?${encodeURIComponent(q)}`;
  console.log("GET", url);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  // Be polite between requests.
  await new Promise((r) => setTimeout(r, 2000));
  return buf;
}

// --- Minimal netCDF-3 (classic / 64-bit offset) reader: enough for ERDDAP's griddap .nc output. ---
function readNetcdf(buf) {
  const magic = buf.toString("latin1", 0, 3);
  const version = buf[3];
  if (magic !== "CDF" || (version !== 1 && version !== 2)) throw new Error("not netCDF-3");
  let p = 4;
  const u32 = () => {
    const v = buf.readUInt32BE(p);
    p += 4;
    return v;
  };
  const name = () => {
    const len = u32();
    const s = buf.toString("utf8", p, p + len);
    p += Math.ceil(len / 4) * 4;
    return s;
  };
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 };
  const skipAttrs = () => {
    u32(); // tag (NC_ATTRIBUTE or ABSENT)
    const n = u32();
    for (let i = 0; i < n; i++) {
      name();
      const type = u32();
      const count = u32();
      p += Math.ceil((count * TYPE_SIZE[type]) / 4) * 4;
    }
  };
  u32(); // numrecs
  const dims = [];
  u32();
  const nDims = u32();
  for (let i = 0; i < nDims; i++) dims.push({ name: name(), len: u32() });
  skipAttrs();
  const vars = {};
  u32();
  const nVars = u32();
  for (let i = 0; i < nVars; i++) {
    const vname = name();
    const nd = u32();
    const dimIds = [];
    for (let d = 0; d < nd; d++) dimIds.push(u32());
    skipAttrs();
    const type = u32();
    u32(); // vsize
    let begin;
    if (version === 2) {
      begin = Number(buf.readBigUInt64BE(p));
      p += 8;
    } else begin = u32();
    vars[vname] = { type, shape: dimIds.map((d) => dims[d].len), begin };
  }
  const read = (vname) => {
    const v = vars[vname];
    const count = v.shape.reduce((a, b) => a * b, 1);
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      if (v.type === 5) out[i] = buf.readFloatBE(v.begin + i * 4);
      else if (v.type === 6) out[i] = buf.readDoubleBE(v.begin + i * 8);
      else if (v.type === 3) out[i] = buf.readInt16BE(v.begin + i * 2);
      else if (v.type === 4) out[i] = buf.readInt32BE(v.begin + i * 4);
      else throw new Error(`unsupported type ${v.type}`);
    }
    return { shape: v.shape, data: out };
  };
  return { vars, read };
}

/** Metres → code byte (see header). */
function encode(m) {
  if (!(m > 0)) return 0;
  if (m <= 2000) return Math.max(1, Math.min(200, Math.round(m / 10)));
  return Math.min(255, 200 + Math.max(1, Math.round((m - 2000) / 125)));
}
/** Code byte → metres. */
function decode(c) {
  if (c <= 0) return 0;
  if (c <= 200) return c * 10;
  return 2000 + (c - 200) * 125;
}

async function buildGrid(grid) {
  const lats = [];
  let lons = null;
  const rows = [];
  for (let b = 0; b + 1 < grid.bands.length; b++) {
    const start = b === 0 ? grid.bands[0] : lats[lats.length - 1] + grid.latStride * SOURCE_STEP_DEG;
    const nc = readNetcdf(await fetchBand(grid, b, start, grid.bands[b + 1]));
    const lat = nc.read("latitude").data;
    const lon = nc.read("longitude").data;
    const z = nc.read("z");
    const [nLat, nLon] = z.shape;
    if (lons && lons.length !== lon.length) throw new Error("longitude mismatch between bands");
    lons = lon;
    for (let i = 0; i < nLat; i++) {
      const row = new Uint8Array(nLon);
      for (let j = 0; j < nLon; j++) row[j] = encode(z.data[i * nLon + j]);
      rows.push(row);
      lats.push(lat[i]);
    }
  }
  if (lats[1] < lats[0]) throw new Error("expected latitude ascending");
  const dLat = (lats[lats.length - 1] - lats[0]) / (lats.length - 1);
  const dLon = (lons[lons.length - 1] - lons[0]) / (lons.length - 1);
  for (let i = 1; i < lats.length; i++)
    if (Math.abs(lats[i] - lats[i - 1] - dLat) > dLat * 0.01) throw new Error(`uneven latitude at row ${i}`);
  return { name: grid.name, south: lats[0], west: lons[0], dLat, dLon, rows };
}

function serialize(grids) {
  const parts = [Buffer.from("SKYTERR1", "latin1"), Buffer.from([grids.length])];
  for (const g of grids) {
    const h = Buffer.alloc(40);
    h.writeDoubleLE(g.south, 0);
    h.writeDoubleLE(g.west, 8);
    h.writeDoubleLE(g.dLat, 16);
    h.writeDoubleLE(g.dLon, 24);
    h.writeUInt32LE(g.rows.length, 32);
    h.writeUInt32LE(g.rows[0].length, 36);
    parts.push(h);
    const cols = g.rows[0].length;
    const body = Buffer.alloc(g.rows.length * cols);
    for (let i = 0; i < g.rows.length; i++)
      for (let j = 0; j < cols; j++) body[i * cols + j] = (g.rows[i][j] - (i > 0 ? g.rows[i - 1][j] : 0)) & 0xff;
    parts.push(body);
  }
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

// --- Radar sampling: the same algorithm as backend TerrainDbService.Sample (keep the two in step). ---
const EARTH_KM = 6371.0088;
const MAX_CELLS = 129;
const MIN_CELL_KM = 0.5;

/** Destination point from (lat, lon) along an initial bearing for a distance (spherical earth). */
function destination(lat, lon, bearingRad, distKm) {
  const d = distKm / EARTH_KM;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(bearingRad));
  const l2 =
    l1 + Math.atan2(Math.sin(bearingRad) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(p2 * 180) / Math.PI, ((((l2 * 180) / Math.PI + 540) % 360) - 180)];
}

function lookup(grids, lat, lon) {
  for (const g of grids) {
    const cols = g.rows[0].length;
    const i = Math.round((lat - g.south) / g.dLat);
    let j = Math.round((lon - g.west) / g.dLon);
    if (g.name === "world") j = ((j % cols) + cols) % cols;
    if (i >= 0 && i < g.rows.length && j >= 0 && j < cols) return decode(g.rows[i][j]);
  }
  return 0;
}

function sample(grids, lat, lon, radiusKm) {
  const cellKm = Math.max(MIN_CELL_KM, (2 * radiusKm) / (MAX_CELLS - 1));
  const half = Math.ceil(radiusKm / cellKm - 1e-9);
  const n = 2 * half + 1;
  // Average sub-samples over a cell much coarser than the source, so a large range doesn't alias.
  const sub = Math.min(4, Math.max(1, Math.round(cellKm / 1.5)));
  const out = new Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      let sum = 0;
      let land = 0;
      for (let a = 0; a < sub; a++)
        for (let b = 0; b < sub; b++) {
          const x = (c - half + (b + 0.5) / sub - 0.5) * cellKm;
          const y = (half - r - (a + 0.5) / sub + 0.5) * cellKm;
          const dist = Math.hypot(x, y);
          const [la, lo] = dist === 0 ? [lat, lon] : destination(lat, lon, Math.atan2(x, y), dist);
          const m = lookup(grids, la, lo);
          if (m > 0) {
            sum += m;
            land++;
          }
        }
      out[r * n + c] = land * 2 > sub * sub ? Math.max(10, Math.round(sum / land / 10) * 10) : 0;
    }
  }
  return { cellKm, size: n, heights: out };
}

const grids = [];
for (const g of GRIDS) grids.push(await buildGrid(g));
for (const g of grids) {
  let land = 0;
  let max = 0;
  for (const row of g.rows)
    for (const c of row)
      if (c > 0) {
        land++;
        max = Math.max(max, c);
      }
  console.log(
    `${g.name}: ${g.rows.length}x${g.rows[0].length} from ${g.south.toFixed(5)},${g.west.toFixed(5)} ` +
      `step ${g.dLat.toFixed(5)}x${g.dLon.toFixed(5)}, land cells ${land}, max ${decode(max)} m`,
  );
}
const out = serialize(grids);
writeFileSync(path.join(here, "terrain.bin.gz"), out);
console.log(`terrain.bin.gz: ${(out.length / 1e6).toFixed(2)} MB`);

// Demo sample: the 100 km grid around the demo home, in the endpoint's response shape.
const DEMO_HOME = JSON.parse(
  readFileSync(path.join(here, "../../app/src/mock/recorded-aircraft.json"), "utf8"),
).home;
const DEMO_RADIUS_KM = 100;
const demo = sample(grids, DEMO_HOME.lat, DEMO_HOME.lon, DEMO_RADIUS_KM);
const demoJson = {
  lat: DEMO_HOME.lat,
  lon: DEMO_HOME.lon,
  radiusKm: DEMO_RADIUS_KM,
  cellKm: demo.cellKm,
  size: demo.size,
  heights: demo.heights,
  attribution: "ETOPO 2022 (NOAA NCEI)",
};
writeFileSync(path.join(here, "../../app/src/mock/demo-terrain.json"), JSON.stringify(demoJson) + "\n");
console.log(`demo-terrain.json: ${demo.size}x${demo.size} cells of ${demo.cellKm.toFixed(3)} km`);
