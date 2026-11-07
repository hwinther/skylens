#!/usr/bin/env node
// Build data/ports/ports.csv.gz, which the Docker image bakes in for GET /api/ports:
//  - Norway: harbours, marinas, ferry terminals and port areas from OpenStreetMap (Overpass API).
//  - Rest of the world (optional): NGA World Port Index (Pub 150) ports, so the layer also works
//    outside Norway. A WPI port within WPI_DEDUPE_M of an OSM place is skipped (WPI coordinates are
//    rounded to ~1-2 km, and the OSM entry is richer).
//
// Run by hand when the data should be refreshed (not at build time: the image must not depend on a
// public API or the NGA portal being up), then commit the output:
//   node data/ports/extract-osm-ports.mjs [--wpi path/to/UpdatedPub150.csv]
// The WPI CSV comes from NGA MSI (Publications -> World Port Index). Without --wpi the output is
// Norway-only.
//
// Data © OpenStreetMap contributors (ODbL 1.0) and the World Port Index (NGA, US public domain); the
// app shows that attribution wherever ports appear.
//
// Output: semicolon-separated, one row per place, sorted by id, no header:
//   id;kind;name;lat;lon
// id    — OSM element (n123 / w456 / r789), or wpi<number> for World Port Index entries
// kind  — port | harbour | marina | ferry
// name  — name or seamark:name (may be empty)
// lat/lon — node position, or the way/relation centre, 5 decimals (~1 m)

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ENDPOINT = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
// Identify ourselves honestly, per the Overpass usage policy.
const USER_AGENT = "skylens-ports-extract/1.0 (+https://github.com/hwinther/skylens)";

const QUERY = `
[out:json][timeout:300];
area["ISO3166-1"="NO"][admin_level=2]->.no;
(
  nwr["leisure"="marina"](area.no);
  nwr["amenity"="ferry_terminal"](area.no);
  nwr["harbour"](area.no);
  nwr["seamark:type"="harbour"](area.no);
  nwr["landuse"="port"](area.no);
  nwr["industrial"="port"](area.no);
);
out center tags;
`;

/** Two places of the same kind and name closer than this are one place (node + area of a marina). */
const DEDUPE_M = 250;

/** A WPI port this close to any OSM place is the same port (WPI positions are rounded). */
const WPI_DEDUPE_M = 3000;

const wpiArg = process.argv.indexOf("--wpi");
const WPI_PATH = wpiArg > 0 ? process.argv[wpiArg + 1] : null;

/** Minimal RFC 4180 reader (quoted fields with commas / doubled quotes) for the WPI CSV. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

/** World Port Index rows as places: Large/Medium harbours are ports, the smaller ones harbours. */
function readWpi(file) {
  const [header, ...rows] = parseCsv(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`WPI CSV has no "${name}" column`);
    return i;
  };
  const [idI, nameI, latI, lonI, sizeI] = [
    "World Port Index Number",
    "Main Port Name",
    "Latitude",
    "Longitude",
    "Harbor Size",
  ].map(col);
  const out = [];
  for (const r of rows) {
    const lat = Number(r[latI]);
    const lon = Number(r[lonI]);
    if (!r[idI] || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const size = (r[sizeI] ?? "").trim();
    out.push({
      id: `wpi${r[idI].trim()}`,
      kind: size === "Large" || size === "Medium" ? "port" : "harbour",
      name: (r[nameI] ?? "").replace(/[;\r\n]+/g, " ").trim(),
      lat,
      lon,
    });
  }
  return out;
}

function classify(tags) {
  const cat = tags["seamark:harbour:category"] ?? tags["harbour:category"] ?? "";
  if (tags.amenity === "ferry_terminal") return "ferry";
  if (tags.leisure === "marina" || /marina|yacht/.test(cat)) return "marina";
  if (tags.landuse === "port" || tags.industrial === "port" || /port|container|bulk|tanker|roro|fishing/.test(cat))
    return "port";
  return "harbour";
}

function distM(a, b) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// The public Overpass instance answers 429/502/504 under load; back off and retry a few times.
async function overpass() {
  const delays = [0, 15_000, 45_000];
  let last;
  for (const delay of delays) {
    if (delay) {
      console.warn(`Overpass busy (${last}); retrying in ${delay / 1000} s`);
      await new Promise((r) => setTimeout(r, delay));
    }
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: QUERY }),
    });
    if (res.ok) return res.json();
    last = `${res.status}: ${(await res.text()).slice(0, 120).trim()}`;
    if (![429, 502, 503, 504].includes(res.status)) break;
  }
  throw new Error(`Overpass ${last}`);
}
const { elements } = await overpass();

const places = [];
for (const el of elements) {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") continue;
  const tags = el.tags ?? {};
  const name = (tags.name ?? tags["seamark:name"] ?? "").replace(/[;\r\n]+/g, " ").trim();
  places.push({ id: `${el.type[0]}${el.id}`, kind: classify(tags), name, lat, lon });
}

// Prefer named, then areas (ways/relations, whose centre sits inside the facility) over loose nodes.
const rank = (p) => (p.name ? 0 : 2) + (p.id[0] === "n" ? 1 : 0);
places.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
const kept = [];
for (const p of places) {
  const dup = kept.some(
    (k) => k.kind === p.kind && (k.name === p.name || !p.name) && distM(k, p) < DEDUPE_M,
  );
  if (!dup) kept.push(p);
}

let wpiAdded = 0;
if (WPI_PATH) {
  const osm = [...kept];
  for (const w of readWpi(WPI_PATH)) {
    // Cheap bounding-box prefilter before the haversine check.
    const near = osm.some(
      (k) => Math.abs(k.lat - w.lat) < 0.05 && Math.abs(k.lon - w.lon) < 0.1 && distM(k, w) < WPI_DEDUPE_M,
    );
    if (!near) {
      kept.push(w);
      wpiAdded++;
    }
  }
}
kept.sort((a, b) => a.id.localeCompare(b.id));

const csv = kept.map((p) => `${p.id};${p.kind};${p.name};${p.lat.toFixed(5)};${p.lon.toFixed(5)}`).join("\n") + "\n";
const gz = gzipSync(Buffer.from(csv, "utf8"), { level: 9 });
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "ports.csv.gz");
writeFileSync(out, gz);

const counts = kept.reduce((m, p) => ((m[p.kind] = (m[p.kind] ?? 0) + 1), m), {});
const unnamed = kept.filter((p) => !p.name).length;
console.log(`osm elements ${elements.length}, wpi added ${wpiAdded} → places ${kept.length} (unnamed ${unnamed})`, counts);
console.log(`wrote ${out} (${gz.length} bytes)`);
console.log(`sha256 ${createHash("sha256").update(gz).digest("hex")}`);
