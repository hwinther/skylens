// Copy Cesium's prebuilt runtime (Cesium.js, Workers, Assets, ThirdParty, Widgets) into public/cesium
// so Expo web serves it (dev) and `expo export` ships it (dist → backend wwwroot). The simulator
// loads /cesium/Cesium.js lazily with a <script> tag instead of bundling ~4 MB of Cesium through
// Metro, which also keeps the CSP at script-src 'self'.
//
// Runs as `postinstall` (local, CI, and the Dockerfile web stage, which copies scripts/ before
// `npm ci`). Idempotent: skips the copy when public/cesium already holds this Cesium version.

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(appDir, "package.json"));

let pkgPath;
try {
  pkgPath = require.resolve("cesium/package.json");
} catch {
  console.warn("[copy-cesium] cesium is not installed; skipping");
  process.exit(0);
}

const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
const src = path.join(path.dirname(pkgPath), "Build", "Cesium");
const dest = path.join(appDir, "public", "cesium");
const stamp = path.join(dest, ".version");

if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version) {
  process.exit(0);
}

rmSync(dest, { recursive: true, force: true });
// index.js / index.cjs are the npm entry shims, not part of the browser runtime.
cpSync(src, dest, {
  recursive: true,
  filter: (p) => !/[\\/]index\.c?js$/.test(p) || path.dirname(p) !== src,
});
// CSP: the bundled Knockout (widgets) resolves the global object with `this||(0,eval)("this")` while
// Cesium.js loads, which the policy's script-src (no 'unsafe-eval') reports, and would block outright
// under CSP_MODE=enforce, breaking the whole script. `globalThis` is the same object without eval.
// Exactly one occurrence is expected; fail loudly if a Cesium upgrade changes that.
const KNOCKOUT_EVAL = 'this||(0,eval)("this")';
const runtime = path.join(dest, "Cesium.js");
const source = readFileSync(runtime, "utf8");
const hits = source.split(KNOCKOUT_EVAL).length - 1;
if (hits !== 1) {
  throw new Error(
    `[copy-cesium] expected 1 occurrence of ${KNOCKOUT_EVAL} in Cesium ${version}, found ${hits}; ` +
      "re-check the CSP patch for this Cesium version",
  );
}
writeFileSync(runtime, source.replace(KNOCKOUT_EVAL, "this||globalThis"));

writeFileSync(stamp, `${version}\n`);
console.log(`[copy-cesium] Cesium ${version} → public/cesium`);
