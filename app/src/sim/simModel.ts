/**
 * The followed object's 3D model in the cockpit view's outside (chase) camera: one Cesium Model at a
 * time, of the class the app picked (./modelClass.ts), from the baked files (./models.ts). Driven by the
 * globe's render loop (src/sim/simGlobe.ts), which keeps its point + heading chevron as the fallback
 * whenever `update` says the model is not drawn: while loading, after a failure, or with no class.
 *
 *  - Lazy: nothing is fetched until the outside view is on with a class set; a class change ("Follow
 *    this" onto another kind of object) disposes the old model at once and loads the new one when shown.
 *  - A class that failed to load (missing file, decode error) is not retried for the globe's lifetime.
 *  - Placed per frame from the same smoothed / dead-reckoned pose the camera uses, so it never jitters
 *    against the view; only scratch objects are reused, nothing is allocated per frame.
 *  - Lit by a headlight from the camera (scene.light): the default sun would leave it black at night.
 *    Nothing else in the scene is lit (points, labels, lines; the globe has lighting off).
 *  - The light single's propeller node spins; the helicopter's rotor is part of its mesh and stays still.
 * Browser only (Cesium + WebGL).
 */

import type { Cartesian3, HeadingPitchRoll, Matrix3, Matrix4, Model, ModelNode, Scene } from "cesium";
import type { Cesium } from "./loadCesium";
import {
  modelAttitude,
  modelHeightM,
  modelScale,
  modelUrl,
  propellerAngle,
  SIM_MODELS,
  type ModelAttitude,
  type SimModelClass,
} from "./models";
import type { SimKind } from "./simPose";
import type { TrackedPose } from "./tracker";

export type SimModelState = "off" | "loading" | "ready" | "failed";

export interface OwnModelOptions {
  /** Where the model files are served (./models.ts modelBaseUrl); relative bases resolve against the page. */
  baseUrl: string;
  /** The current class's state changed (e2e reads it off the view; the fallback follows `update`). */
  onState?: (cls: SimModelClass | null, state: SimModelState) => void;
}

export interface OwnModel {
  /** The class to draw, or null for none (the fallback marker stays). Disposes a model of another class. */
  setClass: (cls: SimModelClass | null) => void;
  /**
   * Place the model for this frame and show or hide it. Starts the load the first time it is shown.
   * Returns true when the model is drawn (the caller hides its fallback marker then).
   */
  update: (pose: TrackedPose, kind: SimKind, terrainM: number | undefined, show: boolean, nowMs: number) => boolean;
  destroy: () => void;
}

interface Loaded {
  cls: SimModelClass;
  model: Model;
  ready: boolean;
  propeller: { node: ModelNode; original: Matrix4; matrix: Matrix4 } | null;
}

/** How far the headlight leans down from the camera's view direction (towards the object's down). */
const HEADLIGHT_DOWN = 0.6;

export function createOwnModel(C: Cesium, scene: Scene, opts: OwnModelOptions): OwnModel {
  const base = new URL(opts.baseUrl, document.baseURI).href;
  let cls: SimModelClass | null = null;
  let loaded: Loaded | null = null;
  let loadingCls: SimModelClass | null = null;
  let token = 0;
  let destroyed = false;
  const failed = new Set<SimModelClass>();
  let reported = "";

  const report = (state: SimModelState) => {
    const key = `${cls ?? ""}|${state}`;
    if (key === reported) return;
    reported = key;
    opts.onState?.(cls, state);
  };
  const stateNow = (): SimModelState => {
    if (!cls) return "off";
    if (failed.has(cls)) return "failed";
    if (loaded?.cls === cls && loaded.ready) return "ready";
    return loadingCls === cls || loaded?.cls === cls ? "loading" : "off";
  };

  const dispose = () => {
    if (loaded && !loaded.model.isDestroyed()) scene.primitives.remove(loaded.model); // removing destroys it
    loaded = null;
  };

  const fail = (which: SimModelClass, err: unknown) => {
    failed.add(which);
    console.warn(`SkylensSim model ${which} failed: ${err instanceof Error ? err.message : String(err)}`);
    if (loaded?.cls === which) dispose();
    if (which === cls) report("failed");
  };

  const load = (which: SimModelClass) => {
    const mine = ++token;
    loadingCls = which;
    report("loading");
    C.Model.fromGltfAsync({ url: modelUrl(base, which), allowPicking: false, scale: 1 })
      .then((model) => {
        if (destroyed || mine !== token) {
          model.destroy();
          return;
        }
        loadingCls = null;
        const entry: Loaded = { cls: which, model, ready: false, propeller: null };
        loaded = entry;
        model.show = false; // until the next update places it
        scene.primitives.add(model);
        model.readyEvent.addEventListener(() => {
          if (loaded !== entry) return;
          entry.ready = true;
          const name = SIM_MODELS[which].propellerNode;
          const node = name ? model.getNode(name) : undefined;
          if (node) {
            entry.propeller = {
              node,
              original: C.Matrix4.clone(node.originalMatrix),
              matrix: new C.Matrix4(),
            };
          }
          if (which === cls) report("ready");
        });
        model.errorEvent.addEventListener((err: unknown) => {
          if (loaded === entry) fail(which, err);
        });
      })
      .catch((err: unknown) => {
        if (destroyed || mine !== token) return;
        loadingCls = null;
        fail(which, err);
      });
  };

  // Scratch, reused every frame.
  const position: Cartesian3 = new C.Cartesian3();
  const hpr: HeadingPitchRoll = new C.HeadingPitchRoll();
  const attitude: ModelAttitude = { headingDeg: 0, pitchDeg: 0, rollDeg: 0 };
  const spin: Matrix3 = new C.Matrix3();
  const spin4: Matrix4 = new C.Matrix4();
  const lightDir: Cartesian3 = new C.Cartesian3();
  const down: Cartesian3 = new C.Cartesian3();
  const light = new C.DirectionalLight({ direction: new C.Cartesian3(0, 0, -1), intensity: 2.2 });
  const previousLight = scene.light;
  let lightOn = false;

  const update: OwnModel["update"] = (pose, kind, terrainM, show, nowMs) => {
    if (destroyed || !cls) return false;
    if (show && !failed.has(cls) && loaded?.cls !== cls && loadingCls !== cls) load(cls);
    const entry = loaded;
    if (!entry || entry.cls !== cls || !entry.ready) {
      if (entry) entry.model.show = false;
      return false;
    }
    entry.model.show = show;
    if (!show) return false;

    modelAttitude(pose, kind, attitude);
    hpr.heading = C.Math.toRadians(attitude.headingDeg);
    hpr.pitch = C.Math.toRadians(attitude.pitchDeg);
    hpr.roll = C.Math.toRadians(attitude.rollDeg);
    C.Cartesian3.fromDegrees(pose.lon, pose.lat, modelHeightM(cls, kind, pose.altM, terrainM), undefined, position);
    // Written into the model's own matrix: Cesium notices the change on its next update.
    C.Transforms.headingPitchRollToFixedFrame(position, hpr, C.Ellipsoid.WGS84, undefined, entry.model.modelMatrix);
    const scale = modelScale(cls, kind);
    if (entry.model.scale !== scale) entry.model.scale = scale;

    if (entry.propeller) {
      C.Matrix3.fromRotationZ(propellerAngle(nowMs), spin);
      C.Matrix4.fromRotation(spin, spin4);
      C.Matrix4.multiply(entry.propeller.original, spin4, entry.propeller.matrix);
      entry.propeller.node.matrix = entry.propeller.matrix;
    }

    // Headlight: along the camera's view, leaning down towards the ground under the object.
    C.Cartesian3.normalize(position, down);
    C.Cartesian3.negate(down, down);
    C.Cartesian3.add(scene.camera.directionWC, C.Cartesian3.multiplyByScalar(down, HEADLIGHT_DOWN, down), lightDir);
    C.Cartesian3.normalize(lightDir, light.direction);
    if (!lightOn) {
      scene.light = light;
      lightOn = true;
    }
    return true;
  };

  return {
    setClass: (next) => {
      if (destroyed || next === cls) return;
      cls = next;
      if (loaded && loaded.cls !== next) dispose();
      if (loadingCls && loadingCls !== next) {
        token++; // the in-flight load is dropped when it lands
        loadingCls = null;
      }
      report(stateNow());
    },
    update,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      token++;
      dispose();
      if (lightOn && !scene.isDestroyed()) scene.light = previousLight;
    },
  };
}
