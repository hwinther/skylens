/**
 * The cockpit frame's static drawing (react-native-svg, web and Android): the geometry from
 * src/sim/cockpitFrame.ts painted as dark, slightly translucent solids with a faint edge highlight
 * along every pane and a soft dark rim just inside it. Memoised on (variant, size): moving the frame
 * (parallax) transforms its parent and never re-renders this tree.
 */

import { memo, useMemo } from "react";
import Svg, { Defs, G, LinearGradient, Path, Stop } from "react-native-svg";
import { color } from "@/theme";
import { frameGeometry, type CockpitFrameVariant } from "@/sim/cockpitFrame";

/** The frame's solids: the app's dark navy, a touch lighter at the top, never fully opaque. */
const SOLID_TOP = "#18293C";
const SOLID_BOTTOM = "#060C14";
const SOLID_OPACITY = 0.88;
/** Raised parts (glareshield, console, desk): a little lighter so they read as a separate surface. */
const PANEL_TOP = "#1E3247";
const PANEL_BOTTOM = "#09121D";
const PANEL_OPACITY = 1;
/** Edge highlight on every pane, and the faint trim lines. */
const EDGE = color.textDim;

export interface SimCockpitFrameSvgProps {
  variant: CockpitFrameVariant;
  width: number;
  height: number;
}

function SimCockpitFrameSvgImpl({ variant, width, height }: SimCockpitFrameSvgProps) {
  const g = useMemo(() => frameGeometry(variant, width, height), [variant, width, height]);
  return (
    <Svg width={g.width} height={g.height} viewBox={`${g.left} ${g.top} ${g.width} ${g.height}`} pointerEvents="none">
      <Defs>
        <LinearGradient id="simFrameSolid" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={SOLID_TOP} />
          <Stop offset="1" stopColor={SOLID_BOTTOM} />
        </LinearGradient>
        <LinearGradient id="simFramePanel" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={PANEL_TOP} />
          <Stop offset="0.35" stopColor={PANEL_BOTTOM} />
          <Stop offset="1" stopColor={PANEL_BOTTOM} />
        </LinearGradient>
      </Defs>
      <Path d={g.body} fill="url(#simFrameSolid)" fillOpacity={SOLID_OPACITY} fillRule="evenodd" />
      {/* A soft dark rim inside each pane (half of the wide stroke falls on the glass), then the highlight. */}
      <G fill="none">
        {g.panes.map((d, i) => (
          <Path key={`rim${i}`} d={d} stroke="#000" strokeOpacity={0.22} strokeWidth={6} />
        ))}
        {g.panes.map((d, i) => (
          <Path key={`edge${i}`} d={d} stroke={EDGE} strokeOpacity={0.26} strokeWidth={1.25} />
        ))}
      </G>
      {g.details.map((d, i) =>
        d.kind === "panel" ? (
          <Path key={`d${i}`} d={d.d} fill="url(#simFramePanel)" fillOpacity={PANEL_OPACITY} />
        ) : (
          <Path key={`d${i}`} d={d.d} fill="none" stroke={EDGE} strokeOpacity={0.2} strokeWidth={1} />
        ),
      )}
    </Svg>
  );
}

export const SimCockpitFrameSvg = memo(SimCockpitFrameSvgImpl);
