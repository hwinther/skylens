/**
 * The cockpit view's window frame over the globe (Android; the web twin is SimCockpitFrame.web.tsx):
 * a generic aeroplane / helicopter / bridge frame (components/SimCockpitFrameSvg.tsx, geometry in
 * src/sim/cockpitFrame.ts) that slides opposite to the look offset as if the head turned inside a fixed
 * cockpit. It never takes a touch: drag-to-look and taps go straight through to the globe below.
 *
 * On Android the look offset reaches the native side through the globe's `onLook` action at most 4 Hz
 * (whole degrees, on change). Rather than more bridge traffic, the frame animates towards each new value
 * over one report interval on the native driver, so a steady drag moves it smoothly.
 */

import { useEffect, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { frameOverscan, frameParallax, type CockpitFrameVariant } from "@/sim/cockpitFrame";
import type { Look } from "@/sim/look";
import { SimCockpitFrameSvg } from "./SimCockpitFrameSvg";

/** One look report interval (SimGlobeView's LOOK_REPORT_MS): the glide towards each new offset. */
export const FRAME_GLIDE_MS = 250;

export interface SimCockpitFrameProps {
  variant: CockpitFrameVariant;
  /** The screen (window) size the frame is laid out for. */
  width: number;
  height: number;
  /** The current look offset (Android: from onLook). */
  look: Look;
  /** Web: read the live offset every frame instead (the render loop's lookRef). Unused on Android. */
  getLook?: () => Look;
}

export function SimCockpitFrame({ variant, width, height, look }: SimCockpitFrameProps) {
  // Created once, at the offset the frame first appears with (a lazy state initialiser, not a ref).
  const [{ x, y, opacity }] = useState(() => {
    const start = frameParallax(look, width, height);
    return {
      x: new Animated.Value(start.x),
      y: new Animated.Value(start.y),
      opacity: new Animated.Value(start.opacity),
    };
  });
  useEffect(() => {
    const to = frameParallax({ yaw: look.yaw, pitch: look.pitch }, width, height);
    const timing = (v: Animated.Value, toValue: number) =>
      Animated.timing(v, { toValue, duration: FRAME_GLIDE_MS, easing: Easing.linear, useNativeDriver: true });
    const anim = Animated.parallel([timing(x, to.x), timing(y, to.y), timing(opacity, to.opacity)]);
    anim.start();
    return () => anim.stop();
  }, [look.yaw, look.pitch, width, height, x, y, opacity]);

  const o = frameOverscan(width, height);
  return (
    <View testID="sim-frame" style={styles.root} pointerEvents="none">
      <Animated.View
        testID={`sim-frame-${variant}`}
        pointerEvents="none"
        style={{
          position: "absolute",
          left: -o.x,
          top: -o.y,
          opacity,
          transform: [{ translateX: x }, { translateY: y }],
        }}
      >
        <SimCockpitFrameSvg variant={variant} width={width} height={height} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, overflow: "hidden" },
});
