/**
 * Projects prebuilt terrain geometry (terrainGeometry.ts) into SVG path strings for the current tilt —
 * pure, no RN imports. The land tint and the coastline are one path each; every ridge row is two (its
 * filled silhouette and its profile line), so the whole relief is at most ~115 SVG elements however
 * detailed it is. Heights go through the projection's z, which is what turns the flat picture into
 * relief as the scope tilts.
 */

import { projectPoint, r1, type RadarProjection } from "./projection";
import { fromViewKm } from "./rotation";
import type { TerrainGeometry } from "./terrainGeometry";

export interface RidgePath {
  /** Silhouette: the profile closed down to sea level, filled to hide the rows behind it. */
  fill: string;
  /** The profile line itself. */
  stroke: string;
  /** 0 for the farthest (top of the screen) row → 1 for the nearest: nearer rows draw brighter. */
  depth: number;
}

export interface TerrainPaths {
  land: string;
  coast: string;
  ridges: RidgePath[];
}

export function terrainPaths(geom: TerrainGeometry, p: RadarProjection): TerrainPaths {
  const land: string[] = [];
  const r = geom.land;
  for (let i = 0; i < r.length; i += 4) {
    const [w, e, n, s] = [r[i], r[i + 1], r[i + 2], r[i + 3]];
    const a = projectPoint(p, w, n);
    const b = projectPoint(p, e, n);
    const c = projectPoint(p, e, s);
    const d = projectPoint(p, w, s);
    land.push(`M${r1(a.x)} ${r1(a.y)}L${r1(b.x)} ${r1(b.y)}L${r1(c.x)} ${r1(c.y)}L${r1(d.x)} ${r1(d.y)}Z`);
  }

  const coast: string[] = [];
  for (const line of geom.coast) {
    for (let i = 0; i < line.length; i += 2) {
      const pt = projectPoint(p, line[i], line[i + 1]);
      coast.push(`${i === 0 ? "M" : "L"}${r1(pt.x)} ${r1(pt.y)}`);
    }
  }

  // The rows are in the view frame they were sampled for. Back to the ground, then through the current
  // projection: they stay registered with the land and blips even while a rebuild for a new view
  // bearing is pending (only their painter's order lags a few degrees behind a drag).
  const rb = geom.ridgeBearingDeg;
  const at = (x: number, y: number, z = 0) => {
    const g = fromViewKm(x, y, rb);
    return projectPoint(p, g.x, g.y, z);
  };
  const rows = geom.ridges.length;
  const ridges: RidgePath[] = geom.ridges.map((row, k) => {
    const fill: string[] = [];
    const stroke: string[] = [];
    for (const run of row.runs) {
      for (let i = 0; i < run.length; i += 2) {
        const pt = at(run[i], row.yKm, run[i + 1]);
        const cmd = `${i === 0 ? "M" : "L"}${r1(pt.x)} ${r1(pt.y)}`;
        fill.push(cmd);
        stroke.push(cmd);
      }
      // Close the silhouette along sea level (a straight line on screen: the row is one ground line).
      const east = at(run[run.length - 2], row.yKm);
      const west = at(run[0], row.yKm);
      fill.push(`L${r1(east.x)} ${r1(east.y)}L${r1(west.x)} ${r1(west.y)}Z`);
    }
    return { fill: fill.join(""), stroke: stroke.join(""), depth: rows > 1 ? k / (rows - 1) : 1 };
  });

  return { land: land.join(""), coast: coast.join(""), ridges };
}
