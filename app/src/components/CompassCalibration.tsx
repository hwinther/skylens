/**
 * Compass calibration control: a status strip element that surfaces the current
 * heading accuracy and lets the user nudge the azimuth trim to align the overlay
 * with a known visible aircraft. Compass error on phones is ±10–25°, so trim +
 * low-pass + this align step is how we get labels onto the right plane.
 */

import { color } from "@/theme";
import { StyleSheet, Text, View } from "react-native";

export interface CompassCalibrationProps {
  /** Heading accuracy bucket (0 worst … 3 best) from watchHeadingAsync. */
  headingAccuracy: number;
  azimuthTrimDeg: number;
}

const ACCURACY_LABELS = ["Unreliable", "Low", "Medium", "High"];

export function CompassCalibration({
  headingAccuracy,
  azimuthTrimDeg,
}: CompassCalibrationProps) {
  const bucket = Math.max(0, Math.min(3, Math.round(headingAccuracy)));
  const dotColor = bucket >= 2 ? color.status.ok : bucket === 1 ? color.status.warn : color.status.error;
  return (
    <View style={styles.wrap}>
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      <Text style={styles.text}>
        Compass: {ACCURACY_LABELS[bucket]}
        {azimuthTrimDeg !== 0 ? `  (trim ${azimuthTrimDeg > 0 ? "+" : ""}${azimuthTrimDeg}°)` : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "center" },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  text: { color: color.text, fontSize: 12 },
});
