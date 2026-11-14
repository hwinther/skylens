# Cockpit view 3D models

The cockpit simulator's outside (chase) camera draws the followed object as a generic low-poly model of
its class. The files are baked into the app at `app/public/models/sim/<class>.glb` (about 270 kB in all),
so the web export, the Docker image's `wwwroot` and the Android APK (`www.bundle/models/sim/`, next to
Cesium) all serve them; the app loads them from `modelBaseUrl()` in `app/src/sim/models.ts`. Which class an
object gets is `app/src/sim/modelClass.ts`.

This folder documents how the files were made, so they can be rebuilt or swapped. It is a by-hand tool:
nothing here runs in CI and the repo gets no new dependency.

| File | What |
| --- | --- |
| `models.json` | Per class: source URL pinned by SHA-256, title / author / licence / page, and the normalisation (yaw, extent in metres, texture size, nodes kept separate, a pre-rotation). |
| `build-models.mjs` | Downloads (or reads from `--cache`) and verifies the sources, converts the `.blend` ones with Blender, normalises and compresses everything into `app/public/models/sim/`. |
| `blend2glb.py` | Blender (headless) export of one mesh object with its authored flat colours. |
| `align-tilted.mjs` | One-off helper that found the levelling rotation for the tilted 747 source. |

## Rebuilding

Node 20+, and for this tool only, these packages installed next to the scripts (they land in
`data/models3d/node_modules/`, which git ignores; no `package.json` or lockfile is added):

```bash
cd data/models3d
npm install --no-save --no-package-lock @gltf-transform/core@4.5.1 @gltf-transform/extensions@4.5.1 \
  @gltf-transform/functions@4.5.1 meshoptimizer@1.3.0 sharp@0.35.5
cd ../..
node data/models3d/build-models.mjs --cache <empty scratch dir> --blender "<path to blender>"
node data/models3d/build-models.mjs --cache <dir> --offline          # again, from the cache only
node data/models3d/build-models.mjs --cache <dir> --only turboprop   # one class
```

Blender 5.x converts the two `.blend` sources. It always runs with `--background --factory-startup
--disable-autoexec`, so no script stored in a downloaded `.blend` runs. Treat the downloads as data and
keep the cache out of the repo.

The output is deterministic for a given cache (a second run gives byte-identical files). The script
prints each file's size and extent; copy changed extents into `SIM_MODELS` in `app/src/sim/models.ts`
(`extentM`, `heightM`; ships also have a hand-set `waterlineM`). `app/__tests__/simModels.test.ts` checks
that there is one file per class, that each is a glTF 2.0 GLB that needs only `EXT_meshopt_compression` /
`KHR_mesh_quantization` (Cesium's own build decodes both, no extra decoder files), and that the credits
match.

## What the build does

1. Source: a Poly Pizza GLB, or a `.blend` file. `blend2glb.py` keeps the one mesh object named in
   `blendObject` (rig, lights, camera and scenery dropped; `blendReset` clears an object stored turned
   and moved in its scene), and rebuilds each material as a single Principled BSDF with the colour read
   from the authored nodes: these old files have a Principled and a Diffuse output, and the glTF
   exporter writes plain white otherwise. Window glass, white in the source, is tinted pale blue.
2. Normalise: bake the node transforms into the meshes (except `keepNodes`, e.g. the light single's
   propeller, which the app spins), apply `pre` (a levelling rotation) and `yawDeg` so the nose / bow
   points along glTF +Z with +Y up, downscale textures to `texSize` px (PNG, default 256), recentre on the
   bounding box and scale uniformly so the longest horizontal extent is `lengthM` metres.
3. Compress: dedup / weld / join / prune, quantise (`KHR_mesh_quantization`), meshopt
   (`EXT_meshopt_compression`).

Cesium turns glTF +Z into the local east axis, so the app's model heading is the course − 90°.

## Licences and credits

Nine models are CC BY 3.0 from [Poly Pizza](https://poly.pizza) (three of them "Poly by Google", whose
licence is confirmed only through Poly Pizza's pages), two are CC0 from OpenGameArt (author mfonasd,
named as a courtesy). CC BY needs title, author, licence, source and a note of the changes: the full list
is `app/public/models/sim/ATTRIBUTION.md`, and the app shows it in Settings → About → "3D models"
(`app/src/sim/modelCredits.ts`). Update all three together when a model changes.

## Swapping or adding a model

Add or edit the entry in `models.json` (new source: put its SHA-256 in; the script prints the actual
hash on a mismatch), rebuild, check the result (orientation, colours, size), then update `SIM_MODELS`,
the credits (`modelCredits.ts`, `ATTRIBUTION.md`) and, for a new class, `modelClass.ts`.
