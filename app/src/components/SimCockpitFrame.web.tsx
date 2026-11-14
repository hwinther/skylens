/**
 * The cockpit view's window frame over the globe (web; see SimCockpitFrame.tsx for Android). The look
 * offset lives in the screen's lookRef, written by drag-to-look and by the render loop in pan/tilt mode,
 * so a requestAnimationFrame loop reads it (`getLook`) and writes the parallax transform straight onto
 * the moving layer, only when it changed: no React render per frame, and the SVG never re-renders.
 * The layer has `pointer-events: none`, so drags and taps reach the globe beneath.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import { frameOverscan, frameParallax } from "@/sim/cockpitFrame";
import type { Look } from "@/sim/look";
import type { SimCockpitFrameProps } from "./SimCockpitFrame";
import { SimCockpitFrameSvg } from "./SimCockpitFrameSvg";

export type { SimCockpitFrameProps } from "./SimCockpitFrame";

function css(look: Look, width: number, height: number): { transform: string; opacity: string } {
  const p = frameParallax(look, width, height);
  return { transform: `translate3d(${p.x}px, ${p.y}px, 0)`, opacity: String(p.opacity) };
}

export function SimCockpitFrame({ variant, width, height, look, getLook }: SimCockpitFrameProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const lookRef = useRef(look);
  const getLookRef = useRef(getLook);
  useEffect(() => {
    lookRef.current = look;
    getLookRef.current = getLook;
  }, [look, getLook]);

  // A layout effect: the first transform is written before the browser paints. React never sets the
  // transform itself (it would put back a stale value on a re-render).
  useLayoutEffect(() => {
    let raf = 0;
    let last = "";
    const step = () => {
      const el = layerRef.current;
      if (el) {
        const s = css(getLookRef.current?.() ?? lookRef.current, width, height);
        const key = s.transform + s.opacity;
        if (key !== last) {
          last = key;
          el.style.transform = s.transform;
          el.style.opacity = s.opacity;
        }
      }
      raf = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(raf);
  }, [width, height]);

  const o = frameOverscan(width, height);
  return (
    <div
      data-testid="sim-frame"
      data-variant={variant}
      style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}
    >
      <div
        ref={layerRef}
        data-testid={`sim-frame-${variant}`}
        style={{
          position: "absolute",
          left: -o.x,
          top: -o.y,
          width: width + 2 * o.x,
          height: height + 2 * o.y,
          pointerEvents: "none",
          willChange: "transform",
        }}
      >
        <SimCockpitFrameSvg variant={variant} width={width} height={height} />
      </div>
    </div>
  );
}
