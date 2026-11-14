/**
 * The tilted Radar's vector layer (react-native-svg): the relief (land tint, coastline, ridge profiles)
 * and the range rings and cardinal cross — all projected through the same RadarProjection as the blips,
 * so they stay registered. Purely decorative: it never takes a touch (blips and controls sit above it).
 * The flat scope keeps its plain-View rings (AircraftRadar), so tilt 0 looks exactly like before.
 */

import { alpha, color } from "@/theme";
import { memo } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { G, Line, Path } from "react-native-svg";
import { projectPoint, ringPath, type RadarProjection } from "@/radar/projection";
import type { TerrainPaths } from "@/radar/terrainPaths";

/** Relief palette: a muted phosphor green for land, so it sits under the blue scope and its blips. */
const LAND = "#5DBB8C";
const COAST = "#8FE6B8";
/** The land tint: LAND at 14 % over the background … */
const LAND_TINT = alpha(LAND, 0.14);
/** … and the same colour opaque, for the ridge silhouettes, so a nearer ridge hides what is behind it. */
const RIDGE_FILL = "#162D31";
export interface RadarScopeSvgProps {
  size: number;
  projection: RadarProjection;
  /** Range-ring fractions of the outer range, drawn only while tilted. */
  rings: readonly number[];
  rangeKm: number;
  /** Terrain paths for this projection; null when there's no terrain to show. */
  terrain: TerrainPaths | null;
}

function RadarScopeSvgImpl({ size, projection: p, rings, rangeKm, terrain }: RadarScopeSvgProps) {
  const tilted = p.tiltDeg > 0;
  const n = projectPoint(p, 0, rangeKm);
  const s = projectPoint(p, 0, -rangeKm);
  const e = projectPoint(p, rangeKm, 0);
  const w = projectPoint(p, -rangeKm, 0);
  return (
    <View style={[StyleSheet.absoluteFill, styles.noTouch]}>
      <Svg width={size} height={size}>
        {terrain ? (
          <G testID="radar-terrain">
            <Path d={terrain.land} fill={LAND_TINT} />
            <Path d={terrain.coast} stroke={alpha(COAST, 0.9)} strokeWidth={1.3} fill="none" />
            {terrain.ridges.map((r, i) => (
              <G key={i}>
                <Path d={r.fill} fill={RIDGE_FILL} />
                <Path d={r.stroke} stroke={alpha(LAND, 0.35 + 0.45 * r.depth)} strokeWidth={1} fill="none" />
              </G>
            ))}
          </G>
        ) : null}
        {tilted ? (
          <G>
            {rings.map((f) => (
              <Path
                key={`ring-${f}`}
                d={ringPath(p, rangeKm * f)}
                stroke={alpha(color.entity.air, 0.32)}
                strokeWidth={1}
                fill="none"
              />
            ))}
            <Line x1={n.x} y1={n.y} x2={s.x} y2={s.y} stroke={alpha(color.entity.air, 0.18)} strokeWidth={1} />
            <Line x1={w.x} y1={w.y} x2={e.x} y2={e.y} stroke={alpha(color.entity.air, 0.18)} strokeWidth={1} />
          </G>
        ) : null}
      </Svg>
    </View>
  );
}

export const RadarScopeSvg = memo(RadarScopeSvgImpl);

const styles = StyleSheet.create({
  noTouch: { pointerEvents: "none" },
});
