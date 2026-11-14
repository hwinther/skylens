# Cockpit view 3D models: provenance and attribution

Generic low-poly models for the followed object in the cockpit simulator's outside (chase) view, one per
class (`app/src/sim/models.ts`, class rule in `app/src/sim/modelClass.ts`). The app credits them in
Settings → About → "3D models" (`app/src/sim/modelCredits.ts`). How the files were made:
`data/models3d/README.md`.

**Changes made to every model** (CC BY 3.0 asks that changes are indicated): reoriented (nose / bow along
glTF +Z, up +Y), recentred on the bounding box, uniformly rescaled to the extent below, scene hierarchy
flattened and meshes joined (named propeller kept), textures downscaled, then quantised
(`KHR_mesh_quantization`) and meshopt-compressed (`EXT_meshopt_compression`). Additional changes are
listed per model.

| File | Class | Title | Author | Licence | Source | Extra changes |
| --- | --- | --- | --- | --- | --- | --- |
| `airliner.glb` | Narrow-body jet | Airplane | jeremy | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Poly Pizza 9Ev6pklkSYp](https://poly.pizza/m/9Ev6pklkSYp) | yaw −90°, span 38 m |
| `widebody.glb` | Wide-body jet | Boeing 747 | Miha Lunar | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Poly Pizza 49CLof4tP2V](https://poly.pizza/m/49CLof4tP2V) | levelled (the source is tilted), length 70 m |
| `turboprop.glb` | Turboprop | Twin turboprop rigged airplane. Low poly. | mfonasd | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | [OpenGameArt](https://opengameart.org/content/twin-turboprop-rigged-airplane-low-poly) | exported from the .blend (mesh `an24` only, rig and other objects dropped), materials rebuilt as plain base colours from the authored ones, window glass tinted pale blue, yaw 180°, span 29 m |
| `twin-prop.glb` | Small twin prop | Low poly twin prop airplane | mfonasd | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | [OpenGameArt](https://opengameart.org/content/low-poly-twin-prop-airplane) | exported from the .blend (mesh `fus.001` only, its scene placement reset, landscape dropped), materials rebuilt as plain base colours, yaw 180°, span 20 m |
| `light-single.glb` | Light aircraft | Small Airplane | Vojtěch Balák | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Poly Pizza 7cvx6ex-xfL](https://poly.pizza/m/7cvx6ex-xfL) | yaw 180°, span 8.3 m, propeller node `Propeller_Cone` kept separate |
| `bizjet.glb` | Business jet | Jet | Poly by Google | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Poly Pizza bgUY8zN2Bq9](https://poly.pizza/m/bgUY8zN2Bq9) | span 20 m, texture 128 px |
| `helicopter.glb` | Helicopter | Helicopter | jeremy | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Poly Pizza eb7b31pjGtQ](https://poly.pizza/m/eb7b31pjGtQ) | yaw −90°, length 12 m (rotor part of the mesh) |
| `cargo-ship.glb` | Cargo ship | Container Ship | Alex Safayan | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Poly Pizza 3AmDGcCu6Ll](https://poly.pizza/m/3AmDGcCu6Ll) | length 200 m |
| `ferry.glb` | Ferry / passenger ship | Cruise liner | jeremy | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Poly Pizza aOikPp4rz68](https://poly.pizza/m/aOikPp4rz68) | yaw 180°, length 120 m |
| `small-boat.glb` | Small boat | Boat | Poly by Google | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Poly Pizza 8vekojz4Abf](https://poly.pizza/m/8vekojz4Abf) | yaw 90°, length 8 m |
| `satellite.glb` | Satellite | Satellite | Poly by Google | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Poly Pizza fmYHY1leH_P](https://poly.pizza/m/fmYHY1leH_P) | length 10 m, texture 256 px |

Credit lines in Poly Pizza's suggested form:

- Airplane by jeremy [CC-BY] (https://creativecommons.org/licenses/by/3.0/) via Poly Pizza (https://poly.pizza/m/9Ev6pklkSYp)
- Boeing 747 by Miha Lunar [CC-BY] (https://creativecommons.org/licenses/by/3.0/) via Poly Pizza (https://poly.pizza/m/49CLof4tP2V)
- Small Airplane by Vojtěch Balák [CC-BY] (https://creativecommons.org/licenses/by/3.0/) via Poly Pizza (https://poly.pizza/m/7cvx6ex-xfL)
- Jet by Poly by Google [CC-BY] (https://creativecommons.org/licenses/by/3.0/) via Poly Pizza (https://poly.pizza/m/bgUY8zN2Bq9)
- Helicopter by jeremy [CC-BY] (https://creativecommons.org/licenses/by/3.0/) via Poly Pizza (https://poly.pizza/m/eb7b31pjGtQ)
- Container Ship by Alex Safayan [CC-BY] (https://creativecommons.org/licenses/by/3.0/) via Poly Pizza (https://poly.pizza/m/3AmDGcCu6Ll)
- Cruise liner by jeremy [CC-BY] (https://creativecommons.org/licenses/by/3.0/) via Poly Pizza (https://poly.pizza/m/aOikPp4rz68)
- Boat by Poly by Google [CC-BY] (https://creativecommons.org/licenses/by/3.0/) via Poly Pizza (https://poly.pizza/m/8vekojz4Abf)
- Satellite by Poly by Google [CC-BY] (https://creativecommons.org/licenses/by/3.0/) via Poly Pizza (https://poly.pizza/m/fmYHY1leH_P)
- Twin turboprop rigged airplane. Low poly. by mfonasd [CC0] via OpenGameArt (https://opengameart.org/content/twin-turboprop-rigged-airplane-low-poly)
- Low poly twin prop airplane by mfonasd [CC0] via OpenGameArt (https://opengameart.org/content/low-poly-twin-prop-airplane)

## Licence notes

- The Poly Pizza models are listed there as CC BY 3.0 (each model's page and its `meta.json` at download
  time, 2026-11-14).
- The three "Poly by Google" models (`bizjet`, `small-boat`, `satellite`) come from Google's retired Poly
  library, where creators chose the licence; their CC BY 3.0 licence is confirmed only through Poly
  Pizza's pages (the original Poly pages are gone). Accepted as such; swap them if that is not enough.
- The two OpenGameArt models are CC0 1.0 (public domain dedication): no credit is required, the author is
  named as a courtesy.
