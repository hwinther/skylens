#!/usr/bin/env node
// Build app/public/models/sim/<class>.glb: the cockpit view's generic low-poly 3D models (one per class,
// see app/src/sim/models.ts), from the sources pinned in models.json (Poly Pizza GLBs, CC BY 3.0, and two
// OpenGameArt .blend files, CC0), each verified by SHA-256. Credits: app/public/models/sim/ATTRIBUTION.md.
//
// Run by hand when a model changes (never in CI), then commit the output. Needs Node 20+ and, only for
// this script, a few npm packages installed next to it (not added to the repo; see README.md):
//   cd data/models3d && npm install --no-save --no-package-lock @gltf-transform/core@4.5.1 \
//     @gltf-transform/extensions@4.5.1 @gltf-transform/functions@4.5.1 meshoptimizer@1.3.0 sharp@0.35.5
//   node data/models3d/build-models.mjs --cache <empty scratch dir> --blender "<path to blender>"
//   node data/models3d/build-models.mjs --cache <dir> --offline          (rebuild from that cache)
//   ... --only turboprop                                                  (one class)
// The .blend sources are converted by Blender (5.x, headless) with blend2glb.py, ALWAYS with
// --factory-startup --disable-autoexec so nothing inside a downloaded .blend runs.
//
// Normalisation, per model: flatten the scene (bake node transforms into meshes, except named nodes to
// keep, e.g. a propeller), an optional pre-rotation (a tilted source), a yaw so the nose / bow points along
// glTF +Z (up +Y), textures downscaled (PNG, texSize px, default 256), recentred on the bounding box and
// uniformly scaled so the longest horizontal extent is lengthM metres; then dedup / weld / join / prune,
// quantise (KHR_mesh_quantization) and meshopt-compress (EXT_meshopt_compression, decoded by Cesium's own
// build, no extra decoder files). It prints each output's size and extent: copy those into SIM_MODELS
// (extentM / heightM) in app/src/sim/models.ts when they change.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const cache = arg("cache");
const blender = arg("blender");
const offline = process.argv.includes("--offline");
const only = arg("only");
const outDir = path.resolve(arg("out", path.join(repo, "app/public/models/sim")));
if (!cache) {
  console.error("usage: build-models.mjs --cache <dir> [--blender <exe>] [--offline] [--only <class>] [--out <dir>]");
  process.exit(2);
}
mkdirSync(cache, { recursive: true });
mkdirSync(outDir, { recursive: true });

let gt;
try {
  const [core, ext, fn, mo, sharp] = await Promise.all([
    import("@gltf-transform/core"),
    import("@gltf-transform/extensions"),
    import("@gltf-transform/functions"),
    import("meshoptimizer"),
    import("sharp"),
  ]);
  gt = { ...core, ...ext, ...fn, ...mo, sharp: sharp.default };
} catch (e) {
  console.error(`Missing npm packages (${e.message}). Install them next to this script, see the header.`);
  process.exit(2);
}
await gt.MeshoptEncoder.ready;
await gt.MeshoptDecoder.ready;
const io = new gt.NodeIO()
  .registerExtensions(gt.ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.encoder": gt.MeshoptEncoder, "meshopt.decoder": gt.MeshoptDecoder });

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** The pinned source in the cache (downloaded unless --offline), checksum verified. */
async function source(m) {
  const file = path.join(cache, `${m.class}${path.extname(new URL(m.url).pathname)}`);
  if (!existsSync(file)) {
    if (offline) throw new Error(`${m.class}: ${file} is not in the cache (--offline)`);
    const res = await fetch(m.url, { headers: { "User-Agent": "skylens-model-build" } });
    if (!res.ok) throw new Error(`${m.class}: ${m.url} → HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const got = sha256(readFileSync(file));
  if (got !== m.sha256) throw new Error(`${m.class}: SHA-256 ${got} ≠ pinned ${m.sha256} (${file})`);
  return file;
}

/** A .blend source as a GLB of the one named mesh object (Blender, headless, autoexec off). */
function fromBlend(m, blendFile) {
  const out = path.join(cache, `${m.class}.blend.glb`);
  if (existsSync(out)) return out;
  if (!blender) throw new Error(`${m.class}: needs --blender to convert ${blendFile}`);
  const args = ["--background", "--factory-startup", "--disable-autoexec", blendFile];
  args.push("--python", path.join(here, "blend2glb.py"), "--", out, m.blendObject);
  if (m.blendReset) args.push("reset");
  execFileSync(blender, args, { stdio: ["ignore", "inherit", "inherit"] });
  return out;
}

const deg = Math.PI / 180;
const matY = (a) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; // column-major
};
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

async function normalise(m, glbFile) {
  const doc = await io.read(glbFile);
  const root = doc.getRoot();
  const keep = new Set(m.keepNodes ?? []);
  await doc.transform(gt.flatten());
  let R = matY((m.yawDeg ?? 0) * deg);
  if (m.pre) R = mul(R, m.pre);
  const scene = root.listScenes()[0];
  const wrapper = doc.createNode("root").setMatrix(R);
  for (const n of scene.listChildren()) {
    scene.removeChild(n);
    wrapper.addChild(n);
  }
  scene.addChild(wrapper);
  if (root.listTextures().length) {
    const size = m.texSize ?? 256;
    await doc.transform(gt.textureCompress({ encoder: gt.sharp, targetFormat: "png", resize: [size, size] }));
  }
  await doc.transform(gt.flatten());
  for (const n of root.listNodes()) {
    if (n.getMesh() && !keep.has(n.getName())) {
      gt.transformMesh(n.getMesh(), n.getWorldMatrix());
      n.setMatrix(IDENTITY);
    }
  }
  const b = gt.getBounds(scene);
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  const s = m.lengthM / Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]);
  const T = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, -cx * s, -cy * s, -cz * s, 1];
  for (const n of root.listNodes()) {
    if (!n.getMesh()) continue;
    if (keep.has(n.getName())) {
      n.setMatrix(mul(T, n.getWorldMatrix()));
      scene.addChild(n);
    } else gt.transformMesh(n.getMesh(), T);
  }
  for (const n of root.listNodes()) if (!n.getMesh() && n.listChildren().length === 0) n.dispose();
  await doc.transform(gt.dedup(), gt.weld(), gt.join({ keepNamed: keep.size > 0 }), gt.prune());
  for (const n of root.listNodes()) if (!keep.has(n.getName())) n.setName(m.class);
  const fb = gt.getBounds(scene);
  await doc.transform(gt.quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
  await doc.transform(gt.meshopt({ encoder: gt.MeshoptEncoder, level: "medium" }));
  const out = path.join(outDir, `${m.class}.glb`);
  await io.write(out, doc);
  const size = fb.max.map((v, i) => (v - fb.min[i]).toFixed(2));
  return { out, bytes: statSync(out).size, size };
}

const config = JSON.parse(readFileSync(path.join(here, "models.json"), "utf8"));
let total = 0;
for (const m of config.models) {
  if (only && m.class !== only) continue;
  const src = await source(m);
  const glb = m.blendObject ? fromBlend(m, src) : src;
  const r = await normalise(m, glb);
  total += r.bytes;
  console.log(`${m.class.padEnd(13)} ${String(r.bytes).padStart(6)} B  extent x/y/z ${r.size.join(" / ")} m  ${path.relative(repo, r.out)}`);
}
console.log(`total ${total} B`);
