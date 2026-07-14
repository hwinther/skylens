/**
 * A single absolutely-positioned fixed-radio-source label in the AR overlay's radio pass.
 *
 * Structurally mirrors PlanetLabel — a Pressable chip with a leader line when decluttered, tappable to
 * open the radio detail sheet — but wears the RADIO signal-lime family (color.entity.radio) distinct
 * from the aircraft blue, vessel teal, satellite violet and planet gold. Radio sources are invisible to
 * the eye (you point an antenna, not your eyes), so the chip renders DIMMER than a planet's: its
 * backing and lime border sit at ~0.6–0.7 of the planet equivalent. The anchor mark is a small
 * crosshair (entityShape.radio = "cross") — an antenna-boresight cue and a colourblind-safe shape.
 */

import { alpha, color } from "@/theme";
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { RadioTargetView } from "@/ar";

export interface RadioLabelProps {
  target: RadioTargetView;
  /** Pixel x of the projected point (label anchor). */
  x: number;
  /** Pixel y after declutter. */
  y: number;
  /** Original anchor y before the declutter push, for the leader line back to the true point. */
  anchorY: number;
  onPress: (key: string) => void;
}

function RadioLabelBase({ target, x, y, anchorY, onPress }: RadioLabelProps) {
  const title = target.short.trim() || target.name.trim() || target.key;
  const pushed = Math.abs(y - anchorY) > 1;

  return (
    <>
      {pushed && (
        <View
          style={[
            styles.leader,
            { left: x, top: Math.min(anchorY, y), height: Math.abs(y - anchorY) },
          ]}
        />
      )}
      <Pressable
        testID={`radio-label-${target.key}`}
        onPress={() => onPress(target.key)}
        style={[styles.label, { left: x, top: y }]}
        hitSlop={8}
      >
        {/* radio = crosshair — a colourblind-safe shape distinct from the other families. */}
        <View style={styles.tick}>
          <View style={styles.tickH} />
          <View style={styles.tickV} />
        </View>
        <View style={styles.titleRow}>
          <MaterialCommunityIcons
            testID={`radio-icon-${target.key}`}
            name="radio-tower"
            size={12}
            color={color.entity.radio}
            style={styles.icon}
          />
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        </View>
      </Pressable>
    </>
  );
}

const CROSS = 11; // crosshair arm span (px)

const styles = StyleSheet.create({
  label: {
    position: "absolute",
    transform: [{ translateX: -6 }, { translateY: -6 }],
    // Dark, dimmer backing than the planet chip (~0.5 vs 0.72) — radio sources are unseen, so their
    // labels sit quieter in the sky. Token-based (no hand-rolled rgba).
    backgroundColor: alpha(color.bg, 0.5),
    borderColor: alpha(color.entity.radio, 0.55),
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    maxWidth: 150,
  },
  // Crosshair anchor: a horizontal + vertical lime bar centred on the true point (left/top of the chip).
  tick: {
    position: "absolute",
    left: -CROSS / 2 - 1,
    top: -CROSS / 2 - 1,
    width: CROSS,
    height: CROSS,
    alignItems: "center",
    justifyContent: "center",
  },
  tickH: { position: "absolute", width: CROSS, height: 1.5, backgroundColor: color.entity.radio },
  tickV: { position: "absolute", width: 1.5, height: CROSS, backgroundColor: color.entity.radio },
  titleRow: { flexDirection: "row", alignItems: "center" },
  icon: { marginRight: 4 },
  title: { color: color.text, fontSize: 12, fontWeight: "600" },
  leader: {
    position: "absolute",
    width: 1,
    backgroundColor: alpha(color.entity.radio, 0.5),
    pointerEvents: "none",
  },
});

export const RadioLabel = memo(RadioLabelBase);
