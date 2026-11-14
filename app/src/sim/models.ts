/**
 * The cockpit view's 3D models for the followed object in the outside (chase) camera: one generic
 * low-poly model per class, baked into the app under public/models/sim/ (copied into the web export and,
 * next to the Android DOM page, into the APK's www.bundle/). Built and credited per
 * data/models3d/README.md; the in-app credits are ./modelCredits.ts.
 *
 * Every file is normalised the same way: nose / bow along glTF +Z, up +Y, origin at the bounding-box
 * centre, metres. Cesium's default axis correction turns glTF +Z into the local east axis, so a
 * heading-pitch-roll frame with heading 0 points the nose east: the model heading is course − 90°.
 *
 * Pure TS (no Cesium), so jest runs it: which file, how big to draw it, how high to place it, and its
 * attitude. src/sim/simModel.ts does the Cesium side. Which class an aircraft or vessel gets is
 * ./modelClass.ts.
 */

import type { SimKind } from "./simPose";

export type SimModelClass =
  | "airliner"
  | "widebody"
  | "turboprop"
  | "twin-prop"
  | "light-single"
  | "bizjet"
  | "helicopter"
  | "cargo-ship"
  | "ferry"
  | "small-boat"
  | "satellite";

export interface SimModelSpec {
  /** File name under the model base URL. */
  file: string;
  /** The file's longest horizontal extent (wing span or length), metres, as normalised. */
  extentM: number;
  /** The file's height, metres (centred on the origin). */
  heightM: number;
  /**
   * Ships: the waterline's height in the file (below the box centre, so negative), metres. The model is
   * lifted by its opposite so the waterline sits on the sea surface.
   */
  waterlineM?: number;
  /** A separately transformed propeller node spun about the model's forward axis, if any. */
  propellerNode?: string;
}

/** Sizes as printed by the pipeline (data/models3d/README.md); a jest test keeps the files in step. */
export const SIM_MODELS: Readonly<Record<SimModelClass, SimModelSpec>> = {
  airliner: { file: "airliner.glb", extentM: 38, heightM: 10.2 },
  widebody: { file: "widebody.glb", extentM: 70, heightM: 16.4 },
  turboprop: { file: "turboprop.glb", extentM: 29, heightM: 8.5 },
  "twin-prop": { file: "twin-prop.glb", extentM: 20, heightM: 5.5 },
  "light-single": { file: "light-single.glb", extentM: 8.3, heightM: 3.5, propellerNode: "Propeller_Cone" },
  bizjet: { file: "bizjet.glb", extentM: 20, heightM: 5.7 },
  helicopter: { file: "helicopter.glb", extentM: 12, heightM: 4.1 },
  // The hull is deep for its length (a toy shape): about the lower 40 % of it is under water.
  "cargo-ship": { file: "cargo-ship.glb", extentM: 200, heightM: 78.2, waterlineM: -24 },
  ferry: { file: "ferry.glb", extentM: 120, heightM: 34.2, waterlineM: -12 },
  "small-boat": { file: "small-boat.glb", extentM: 8, heightM: 1.2, waterlineM: -0.35 },
  satellite: { file: "satellite.glb", extentM: 10, heightM: 3.3 },
};

export const SIM_MODEL_CLASSES = Object.keys(SIM_MODELS) as SimModelClass[];

export function isSimModelClass(v: unknown): v is SimModelClass {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(SIM_MODELS, v);
}

/** Where the models are served by default: public/models/sim/ at the web server's root. */
export const MODEL_BASE = "/models/sim/";

/**
 * The model base URL from an Expo base URL (`process.env.EXPO_BASE_URL`), like cesiumBaseUrl: "" (the
 * web app, a DOM component in development) → "/models/sim/"; an exported DOM component has "./" (its
 * page is www.bundle/<hash>.html in the APK and public/ is copied next to it) → "./models/sim/".
 * A later move to server-hosted models only changes what this returns.
 */
export function modelBaseUrl(expoBaseUrl: string | undefined): string {
  const base = expoBaseUrl ?? "";
  if (!base) return MODEL_BASE;
  return `${base.endsWith("/") ? base : `${base}/`}models/sim/`;
}

/** The file's URL under `base` (relative bases resolve against the page). */
export function modelUrl(base: string, cls: SimModelClass): string {
  return `${base.endsWith("/") ? base : `${base}/`}${SIM_MODELS[cls].file}`;
}

/**
 * The smallest extent a model is drawn at, per kind: real size is tiny at the chase distance (a Cessna
 * at 350 m is a few pixels on a phone), so small craft are drawn larger, never smaller. About a tenth of
 * the kind's base chase distance (src/sim/chase.ts); a satellite, seen end-on from behind, a bit more.
 */
export const MIN_DRAWN_EXTENT_M: Readonly<Record<SimKind, number>> = {
  aircraft: 24,
  vessel: 16,
  satellite: 600,
};

/** How much larger than life the model is drawn (≥ 1): small craft are scaled up to MIN_DRAWN_EXTENT_M. */
export function modelScale(cls: SimModelClass, kind: SimKind): number {
  return Math.max(1, MIN_DRAWN_EXTENT_M[kind] / SIM_MODELS[cls].extentM);
}

/** The model's drawn extent, metres (the chase camera keeps its distance from it, see chaseSpec). */
export function drawnExtentM(cls: SimModelClass, kind: SimKind): number {
  return SIM_MODELS[cls].extentM * modelScale(cls, kind);
}

/**
 * The height the model's origin is placed at, metres above the ellipsoid, for this frame's pose:
 *  - aircraft / satellites: at the pose, an aircraft lifted by half its drawn height so a parked or
 *    taxiing aircraft stands on the ground (the pose is already kept above the terrain);
 *  - vessels: on the water whatever the camera's eye height, the drawn waterline on the surface under it
 *    (the terrain height there when known and above sea level, e.g. a lake; else sea level, 0).
 */
export function modelHeightM(
  cls: SimModelClass,
  kind: SimKind,
  poseAltM: number,
  terrainM: number | null | undefined,
): number {
  const spec = SIM_MODELS[cls];
  const scale = modelScale(cls, kind);
  if (kind === "vessel") {
    const surface = typeof terrainM === "number" && Number.isFinite(terrainM) ? Math.max(0, terrainM) : 0;
    return surface - (spec.waterlineM ?? -spec.heightM / 2) * scale;
  }
  if (kind === "aircraft") return poseAltM + (spec.heightM / 2) * scale;
  return poseAltM;
}

/** The model's pitch follows the flight path only this far (a 1 Hz baro rate can spike). */
export const MAX_MODEL_PITCH_DEG = 15;

export interface ModelAttitude {
  /** Cesium heading (0 = nose east, clockwise), degrees. */
  headingDeg: number;
  /** Nose up positive, degrees. */
  pitchDeg: number;
  /** Right wing down positive, degrees. */
  rollDeg: number;
}

export interface ModelPoseInput {
  /** Direction of travel, degrees true. */
  headingDeg: number;
  /** Flight-path angle, degrees (0 when unknown). */
  pathPitchDeg?: number;
  /** Bank into the turn, degrees (0 when unknown). */
  bankDeg?: number;
}

/**
 * The model's attitude: heading from the track, and for aircraft a modest pitch along the flight path
 * and the tracker's bank into turns. Ships and satellites stay level.
 */
export function modelAttitude(pose: ModelPoseInput, kind: SimKind, out?: ModelAttitude): ModelAttitude {
  const o = out ?? { headingDeg: 0, pitchDeg: 0, rollDeg: 0 };
  o.headingDeg = pose.headingDeg - 90;
  const flies = kind === "aircraft";
  const pitch = flies ? (pose.pathPitchDeg ?? 0) : 0;
  o.pitchDeg = Math.max(-MAX_MODEL_PITCH_DEG, Math.min(MAX_MODEL_PITCH_DEG, Number.isFinite(pitch) ? pitch : 0));
  const roll = flies ? (pose.bankDeg ?? 0) : 0;
  o.rollDeg = Number.isFinite(roll) ? roll : 0;
  return o;
}

/** Propeller turns per second as drawn: fast enough to read as spinning, slow enough not to strobe. */
export const PROPELLER_TURNS_PER_S = 4;

/** The propeller's angle (radians, about the forward axis) at `nowMs`. */
export function propellerAngle(nowMs: number): number {
  return ((nowMs / 1000) * PROPELLER_TURNS_PER_S * 2 * Math.PI) % (2 * Math.PI);
}
