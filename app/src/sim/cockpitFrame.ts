/**
 * Pure-TS geometry for the cockpit view's window frame: a generic, 2D frame drawn over the globe in the
 * cockpit camera (components/SimCockpitFrame.tsx renders it as SVG). Three variants: an aeroplane
 * windscreen (centre post, A-pillars, side windows, glareshield), a helicopter bubble canopy (curved
 * frame members, centre post, low console with chin windows either side) and a ship's bridge (a row of
 * windows with mullions between a header and a sill). Satellites get none.
 *
 * Geometry: the frame is laid out in screen pixels for the actual window size (not a stretched viewBox),
 * so posts keep about the same thickness in px on a phone and on a desktop, and the windows adapt to
 * the aspect ratio. The canvas is larger than the screen by an overscan margin on every side; at rest
 * the screen shows its middle. The solid is one even-odd path: the whole canvas minus the window panes,
 * so the posts and pillars are simply what is left between panes and the canvas never shows an edge.
 *
 * Parallax: looking around turns the head inside a fixed cockpit, so the frame slides opposite to the
 * look offset (look right → frame moves left, look up → it moves down), saturating smoothly (tanh) at
 * the overscan so no canvas edge ever comes into view. Looking far to the side it fades, and behind
 * (where we draw no rear cabin) it is gone, which also hides the wrap from +180° to −180°.
 */

import { isRotorcraft } from "@/aircraft/aircraftType";
import { wrap180, type Look } from "./look";
import type { SimKind } from "./simPose";

export type CockpitFrameVariant = "aeroplane" | "helicopter" | "vessel";

export const COCKPIT_FRAME_VARIANTS: readonly CockpitFrameVariant[] = ["aeroplane", "helicopter", "vessel"];

/**
 * The frame for a followed object: aircraft by the shared rotor rule (type table, else category A7),
 * vessels the bridge, satellites none. An aircraft not (yet) in the store counts as an aeroplane.
 */
export function frameVariant(
  kind: SimKind,
  aircraft?: { t?: string | null; cat?: string | null } | null,
): CockpitFrameVariant | null {
  if (kind === "vessel") return "vessel";
  if (kind === "aircraft") return aircraft && isRotorcraft(aircraft) ? "helicopter" : "aeroplane";
  return null;
}

// --- parallax ------------------------------------------------------------------------------------

/** Overscan beyond each screen edge, as a share of the screen's width / height. */
export const FRAME_OVERSCAN_X = 0.35;
export const FRAME_OVERSCAN_Y = 0.2;
/** Look angle (deg) at which the slide reaches tanh(1) ≈ 76 % of the overscan. */
export const FRAME_YAW_SCALE_DEG = 35;
export const FRAME_PITCH_SCALE_DEG = 25;
/** Fully drawn up to this yaw (deg) … */
export const FRAME_FADE_START_DEG = 60;
/** … dimmed to FRAME_SIDE_OPACITY by this yaw … */
export const FRAME_FADE_SIDE_DEG = 120;
export const FRAME_SIDE_OPACITY = 0.6;
/** … and gone (looking behind) from this yaw on. */
export const FRAME_FADE_OUT_DEG = 165;

export interface FrameOverscan {
  x: number;
  y: number;
}

export function frameOverscan(width: number, height: number): FrameOverscan {
  return { x: Math.round(Math.max(0, width) * FRAME_OVERSCAN_X), y: Math.round(Math.max(0, height) * FRAME_OVERSCAN_Y) };
}

export interface FrameOffset {
  /** Translation of the frame from its rest position, px (right / down positive). */
  x: number;
  y: number;
  opacity: number;
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const round1 = (v: number) => Math.round(v * 10) / 10 || 0;

/** Where the frame sits for a look offset on a width × height view (see the module comment). */
export function frameParallax(look: Look, width: number, height: number): FrameOffset {
  const o = frameOverscan(width, height);
  const yaw = wrap180(Number.isFinite(look.yaw) ? look.yaw : 0);
  const pitch = Math.max(-90, Math.min(90, Number.isFinite(look.pitch) ? look.pitch : 0));
  const a = Math.abs(yaw);
  const opacity =
    a <= FRAME_FADE_SIDE_DEG
      ? 1 - (1 - FRAME_SIDE_OPACITY) * smoothstep(FRAME_FADE_START_DEG, FRAME_FADE_SIDE_DEG, a)
      : FRAME_SIDE_OPACITY * (1 - smoothstep(FRAME_FADE_SIDE_DEG, FRAME_FADE_OUT_DEG, a));
  return {
    x: round1(-o.x * Math.tanh(yaw / FRAME_YAW_SCALE_DEG)),
    y: round1(o.y * Math.tanh(pitch / FRAME_PITCH_SCALE_DEG)),
    opacity: Math.round(opacity * 1000) / 1000,
  };
}

// --- geometry ------------------------------------------------------------------------------------

export type FrameDetailKind = "panel" | "line";

export interface FrameDetail {
  /** "panel": a raised solid (glareshield, console) drawn over the frame; "line": a faint trim line. */
  kind: FrameDetailKind;
  d: string;
}

export interface FrameGeometry {
  variant: CockpitFrameVariant;
  /** Canvas size, px (the screen plus the overscan on every side). */
  width: number;
  height: number;
  /** The canvas's top-left corner relative to the screen's at rest: (−overscan.x, −overscan.y). */
  left: number;
  top: number;
  /** The frame's solid: the canvas minus the panes (fill-rule even-odd). Paths are in screen px. */
  body: string;
  /** Each pane's outline, for the edge highlight. */
  panes: string[];
  details: FrameDetail[];
}

type Pt = readonly [number, number];
/** A polygon vertex with its corner radius (0 = sharp, used for points sampled along a curve). */
type Vertex = readonly [number, number, number];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const f = (v: number) => (Math.round(v * 10) / 10 || 0).toString();

/** Closed path through the vertices, each corner rounded by its radius (cut back at most half an edge). */
export function roundedPolygon(vertices: readonly Vertex[]): string {
  const n = vertices.length;
  if (n < 3) return "";
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const [x, y, r] = vertices[i];
    const [px, py] = vertices[(i - 1 + n) % n];
    const [nx, ny] = vertices[(i + 1) % n];
    const lp = Math.hypot(px - x, py - y);
    const ln = Math.hypot(nx - x, ny - y);
    const cut = Math.min(r, lp / 2, ln / 2);
    if (cut <= 0.01 || lp === 0 || ln === 0) {
      parts.push(`${i === 0 ? "M" : "L"}${f(x)} ${f(y)}`);
      continue;
    }
    const ax = x + ((px - x) / lp) * cut;
    const ay = y + ((py - y) / lp) * cut;
    const bx = x + ((nx - x) / ln) * cut;
    const by = y + ((ny - y) / ln) * cut;
    parts.push(`${i === 0 ? "M" : "L"}${f(ax)} ${f(ay)}`, `Q${f(x)} ${f(y)} ${f(bx)} ${f(by)}`);
  }
  return parts.join("") + "Z";
}

function quad(p0: Pt, c: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]];
}

/** The screen-space layout for one variant; `T` is the base post thickness in px. */
interface Layout {
  panes: Vertex[][];
  details: FrameDetail[];
}

/** Base post thickness: about the same on every screen (10 px on a small phone, 20 px on a desktop). */
export function framePostPx(width: number, height: number): number {
  return clamp(Math.min(width, height) * 0.03, 10, 20);
}

/** Mirror a pane about the screen's vertical centre line (reversing the winding stays a valid polygon). */
function mirror(pane: readonly Vertex[], w: number): Vertex[] {
  return pane.map(([x, y, r]) => [w - x, y, r] as Vertex).reverse();
}

function aeroplane(w: number, h: number, T: number, o: FrameOverscan): Layout {
  const cx = w / 2;
  const glare = clamp(0.15 * h, 64, 150); // glareshield height above the bottom edge
  const yG = h - glare;
  const yT0 = clamp(0.075 * h, 28, 72); // windscreen top at the centre post …
  const yT1 = yT0 + clamp(0.05 * h, 18, 50); // … dipping towards the A-pillars
  const tc = 0.32 * T; // centre post half width at the top …
  const tb = 0.5 * T; // … and at the glareshield
  // The view is from the left seat: the left A-pillar is close (near the left edge), the centre post
  // right of the view's centre (never through the flight-path marker), the right A-pillar far right,
  // mostly in the overscan, so it comes into view when looking right.
  const xc = cx + clamp(0.16 * w, 50, 200);
  const aB = 0.015 * w; // left A-pillar (inner edge) at the glareshield …
  const aT = Math.min(0.11 * w, 150); // … leaning in towards the top
  const span = xc - aB;
  const rB = xc + 0.92 * span; // right A-pillar (inner edge) at the glareshield …
  const rT = rB - (aT - aB) * 0.8; // … leaning in too
  const ta = 1.7 * T; // A-pillar width
  const r = 0.9 * T;
  const yBottom = yG + T; // panes run under the glareshield's edge

  // The windscreen's top edge: level at the centre post, curving down towards each A-pillar.
  const topEdge = (from: number, to: number): Vertex[] => {
    const pts: Vertex[] = [];
    for (let i = 1; i < 10; i++) {
      const t = i / 10;
      pts.push([from + (to - from) * t, yT0 + (yT1 - yT0) * t * t, 0]);
    }
    return pts;
  };
  const left: Vertex[] = [
    [aB, yBottom, 0.4 * T],
    [aT, yT1, r],
    ...topEdge(xc - tc, aT).reverse(),
    [xc - tc, yT0, r * 0.7],
    [xc - tb, yBottom, 0.4 * T],
  ];
  const right: Vertex[] = [
    [xc + tb, yBottom, 0.4 * T],
    [xc + tc, yT0, r * 0.7],
    ...topEdge(xc + tc, rT),
    [rT, yT1, r],
    [rB, yBottom, 0.4 * T],
  ];
  // Side windows: inner edge along each A-pillar's outer side. On the left a rear post in the overscan
  // and the cabin wall beyond it; on the right (further away) the window runs off the canvas.
  const sideTop = yT1 + clamp(0.03 * h, 10, 30);
  const sideDip = clamp(0.04 * h, 14, 40);
  const alongLeft = (y: number) => aB - ta + ((aT - aB) * (yG - y)) / (yG - yT1);
  const alongRight = (y: number) => rB + ta - ((rB - rT) * (yG - y)) / (yG - yT1);
  const rear = -0.5 * o.x;
  const leftSide: Vertex[] = [
    [alongLeft(yBottom), yBottom, 0.4 * T],
    [alongLeft(sideTop), sideTop, r],
    [rear, sideTop + sideDip, r],
    [rear, yBottom, 0.4 * T],
  ];
  const far = w + o.x + 4 * T;
  const rightSide: Vertex[] = [
    [far, yBottom, 0],
    [far, sideTop + sideDip, 0],
    [alongRight(sideTop), sideTop, r],
    [alongRight(yBottom), yBottom, 0.4 * T],
  ];

  // The glareshield: a padded ledge with a raised hood over the instruments, down to the canvas bottom.
  const hood = clamp(0.2 * w, 90, 260); // hood half width
  const ramp = clamp(0.08 * w, 30, 110);
  const yHood = yG - clamp(0.28 * glare, 18, 40);
  const L = -o.x - 2;
  const R = w + o.x + 2;
  const B = h + o.y + 2;
  const glareshield =
    `M${f(L)} ${f(yG)}L${f(cx - hood - ramp)} ${f(yG)}` +
    `C${f(cx - hood - ramp * 0.35)} ${f(yG)} ${f(cx - hood - ramp * 0.25)} ${f(yHood)} ${f(cx - hood + ramp * 0.3)} ${f(yHood)}` +
    `L${f(cx + hood - ramp * 0.3)} ${f(yHood)}` +
    `C${f(cx + hood + ramp * 0.25)} ${f(yHood)} ${f(cx + hood + ramp * 0.35)} ${f(yG)} ${f(cx + hood + ramp)} ${f(yG)}` +
    `L${f(R)} ${f(yG)}L${f(R)} ${f(B)}L${f(L)} ${f(B)}Z`;
  // Its front edge catches the light; a seam just above the windscreen hints at the overhead panel.
  const lip =
    `M${f(L)} ${f(yG + 2)}L${f(cx - hood - ramp)} ${f(yG + 2)}` +
    `C${f(cx - hood - ramp * 0.35)} ${f(yG + 2)} ${f(cx - hood - ramp * 0.25)} ${f(yHood + 2)} ${f(cx - hood + ramp * 0.3)} ${f(yHood + 2)}` +
    `L${f(cx + hood - ramp * 0.3)} ${f(yHood + 2)}` +
    `C${f(cx + hood + ramp * 0.25)} ${f(yHood + 2)} ${f(cx + hood + ramp * 0.35)} ${f(yG + 2)} ${f(cx + hood + ramp)} ${f(yG + 2)}` +
    `L${f(R)} ${f(yG + 2)}`;
  const yHoodPanel = yG + clamp(0.4 * glare, 26, 60);
  const seam = `M${f(L)} ${f(yHoodPanel)}L${f(R)} ${f(yHoodPanel)}`;
  const yOverhead = yT0 - clamp(0.45 * yT0, 12, 30);
  const overhead = `M${f(L)} ${f(yOverhead - 0.4 * (yT1 - yT0))}Q${f(cx)} ${f(yOverhead - 0.1 * (yT1 - yT0))} ${f(R)} ${f(yOverhead - 0.4 * (yT1 - yT0))}`;

  return {
    panes: [left, right, leftSide, rightSide],
    details: [
      { kind: "line", d: overhead },
      { kind: "panel", d: glareshield },
      { kind: "line", d: lip },
      { kind: "line", d: seam },
    ],
  };
}

function helicopter(w: number, h: number, T: number, o: FrameOverscan): Layout {
  const cx = w / 2;
  const yF = h - clamp(0.035 * h, 12, 30); // floor / pedal area top
  const yR = h - clamp(0.24 * h, 90, 220); // the canopy's lower rail
  const tr = 0.4 * T; // rail half thickness
  const tp = 0.28 * T; // centre post half width
  const tm = 0.45 * T; // curved member half width
  // The view is from the right seat (where helicopter pilots sit): the cabin's centre line, with the
  // centre post and the console, is left of the view's centre (never through the flight-path marker).
  const xc = cx - clamp(0.14 * w, 40, 170);
  const yRoof0 = clamp(0.04 * h, 14, 40);
  // The cabin roof's lower edge rises towards the sides (a bubble).
  const roof = (x: number) => yRoof0 - 0.1 * h * ((x - cx) / (0.5 * w)) ** 2;
  // The left canopy bow: from the rail, bulging out towards the edge, up to the roof (mirrored right).
  const m0: Pt = [0.08 * w, yR];
  const m1x = 0.27 * w;
  const m1: Pt = [m1x, roof(m1x)];
  const mc: Pt = [-0.04 * w, 0.48 * h];
  const STEPS = 18;
  const bow = (dx: number, fromTop: boolean): Vertex[] => {
    const pts: Vertex[] = [];
    for (let i = 1; i < STEPS; i++) {
      const t = fromTop ? 1 - i / STEPS : i / STEPS;
      const [x, y] = quad(m0, mc, m1, t);
      pts.push([x + dx, y, 0]);
    }
    return pts;
  };
  const roofRun = (x0: number, x1: number): Vertex[] => {
    const pts: Vertex[] = [];
    for (let i = 1; i < 8; i++) {
      const x = x0 + ((x1 - x0) * i) / 8;
      pts.push([x, roof(x), 0]);
    }
    return pts;
  };
  const r = 0.9 * T;
  const yRailTop = yR - tr;
  const yRailBottom = yR + tr;
  // Front pane on the left of the view, with the centre post at `post`: rail → post → roof → down the
  // bow. The right one is the same built for the mirrored post, then mirrored.
  const front = (post: number): Vertex[] => [
    [m0[0] + tm, yRailTop, 0.5 * T],
    [post - tp, yRailTop, 0.3 * T],
    [post - tp, roof(post - tp), r],
    ...roofRun(post - tp, m1[0] + tm),
    [m1[0] + tm, roof(m1[0] + tm), r],
    ...bow(tm, true),
  ];
  // Side (door) pane: from the bow out to a door post in the overscan.
  const door = -0.45 * o.x;
  const side: Vertex[] = [
    [door, yRailTop, 0.5 * T],
    [m0[0] - tm, yRailTop, 0.5 * T],
    ...bow(-tm, false),
    [m1[0] - tm, roof(m1[0] - tm), r],
    ...roofRun(m1[0] - tm, door),
    [door, roof(door), r],
  ];
  // The console: a low rounded box on the cabin's centre line, a little wider at the floor.
  const wc = clamp(0.32 * w, 140, 380);
  const yC = yR - clamp(0.06 * h, 22, 56);
  const flare = 0.05 * wc;
  const cl = xc - wc / 2;
  const cr = xc + wc / 2;
  const B = h + o.y + 2;
  const cRad = Math.min(0.18 * wc, 40);
  const consolePath =
    `M${f(cl - flare * 2)} ${f(B)}L${f(cl - flare)} ${f(yF)}L${f(cl)} ${f(yC + cRad)}` +
    `Q${f(cl)} ${f(yC)} ${f(cl + cRad)} ${f(yC)}L${f(cr - cRad)} ${f(yC)}Q${f(cr)} ${f(yC)} ${f(cr)} ${f(yC + cRad)}` +
    `L${f(cr + flare)} ${f(yF)}L${f(cr + flare * 2)} ${f(B)}Z`;
  const consoleLip = `M${f(cl + 2)} ${f(yC + cRad)}Q${f(cl + 2)} ${f(yC + 2)} ${f(cl + cRad)} ${f(yC + 2)}L${f(cr - cRad)} ${f(yC + 2)}Q${f(cr - 2)} ${f(yC + 2)} ${f(cr - 2)} ${f(yC + cRad)}`;
  const yFace = yC + clamp(0.35 * (yF - yC), 18, 50);
  const consoleFace = `M${f(cl + 0.6 * T)} ${f(yFace)}L${f(cr - 0.6 * T)} ${f(yFace)}`;
  // Chin window on the left of the view, below the rail, between the bow's foot and the console edge
  // `edge` (left out where the console leaves it no room, as on a narrow phone).
  const gap = 0.7 * T;
  const chin = (edge: number): Vertex[] | null => {
    const x0 = m0[0] + tm;
    if (edge - gap - flare - x0 < 3 * T) return null;
    return [
      [x0, yRailBottom, 0.6 * T],
      [edge - gap, yRailBottom, 0.6 * T],
      [edge - flare - gap, yF - 0.3 * T, 1.6 * T],
      [x0 + 0.15 * (yF - yR), yF - 0.3 * T, 1.2 * T],
    ];
  };
  const chinLeft = chin(cl);
  const chinRight = chin(w - cr);
  const panes: Vertex[][] = [front(xc), mirror(front(w - xc), w), side, mirror(side, w)];
  if (chinLeft) panes.push(chinLeft);
  if (chinRight) panes.push(mirror(chinRight, w));
  return {
    panes,
    details: [
      { kind: "panel", d: consolePath },
      { kind: "line", d: consoleLip },
      { kind: "line", d: consoleFace },
    ],
  };
}

function vessel(w: number, h: number, T: number, o: FrameOverscan): Layout {
  const cx = w / 2;
  const yH = clamp(0.1 * h, 36, 90); // header's lower edge
  const yS = h - clamp(0.16 * h, 60, 150); // sill
  const tm = 0.6 * T; // mullion half width
  // Window pitch: wide enough that a tall phone screen doesn't look through bars. One window is centred
  // straight ahead.
  const S = clamp(Math.max(0.34 * w, 0.21 * h), 150, 440);
  // The windows rake outwards at the top, so the mullions converge slightly towards the centre there.
  const RAKE = 0.95;
  const top = (x: number) => cx + (x - cx) * RAKE;
  const n = Math.ceil((w / 2 + o.x) / (S * RAKE)) + 1;
  const r = 0.7 * T;
  const panes: Vertex[][] = [];
  for (let i = -n; i <= n; i++) {
    const x0 = cx + (i - 0.5) * S + tm;
    const x1 = cx + (i + 0.5) * S - tm;
    panes.push([
      [top(x0), yH, r],
      [top(x1), yH, r],
      [x1, yS, r * 0.6],
      [x0, yS, r * 0.6],
    ]);
  }
  const L = -o.x - 2;
  const R = w + o.x + 2;
  const B = h + o.y + 2;
  // The console desk behind the sill, and trim lines along the header (a sun-visor rail) and the
  // desk's front edge.
  const yDesk = yS + clamp(0.035 * h, 12, 30);
  const desk = `M${f(L)} ${f(yDesk)}L${f(R)} ${f(yDesk)}L${f(R)} ${f(B)}L${f(L)} ${f(B)}Z`;
  const deskLip = `M${f(L)} ${f(yDesk + 2)}L${f(R)} ${f(yDesk + 2)}`;
  const yVisor = yH - clamp(0.3 * yH, 10, 22);
  const header = `M${f(L)} ${f(yVisor)}L${f(R)} ${f(yVisor)}`;
  const header2 = `M${f(L)} ${f(yVisor - 4)}L${f(R)} ${f(yVisor - 4)}`;
  return {
    panes,
    details: [
      { kind: "line", d: header2 },
      { kind: "line", d: header },
      { kind: "panel", d: desk },
      { kind: "line", d: deskLip },
    ],
  };
}

/**
 * The frame for a variant on a width × height screen. Every path is in screen px (the screen's top-left
 * at rest is 0,0); the canvas spans (left, top) = (−overscan.x, −overscan.y) to the far overscan edge,
 * so a renderer uses `viewBox="left top width height"` and places the canvas at (left, top).
 */
export function frameGeometry(variant: CockpitFrameVariant, width: number, height: number): FrameGeometry {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const o = frameOverscan(w, h);
  const T = framePostPx(w, h);
  const layout =
    variant === "aeroplane" ? aeroplane(w, h, T, o) : variant === "helicopter" ? helicopter(w, h, T, o) : vessel(w, h, T, o);
  const W = w + 2 * o.x;
  const H = h + 2 * o.y;
  const panes = layout.panes.map((p) => roundedPolygon(p));
  return {
    variant,
    width: W,
    height: H,
    left: -o.x,
    top: -o.y,
    body: `M${f(-o.x)} ${f(-o.y)}H${f(w + o.x)}V${f(h + o.y)}H${f(-o.x)}Z` + panes.join(""),
    panes,
    details: layout.details,
  };
}
