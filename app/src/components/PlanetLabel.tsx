/**
 * A single absolutely-positioned Solar-System body label in the AR overlay's sky pass.
 *
 * Structurally mirrors SatelliteLabel — a Pressable chip with a leader line when decluttered, tappable
 * to open the planet detail sheet — but wears a warm GOLD family distinct from the aircraft blue,
 * vessel teal, satellite violet and AtoN amber (planets sit high in the sky vs the horizon-band aids,
 * so gold vs amber never collide spatially). The body's glyph (a sun / moon / filled dot) and the dot's
 * size (brighter = larger, via planetDotSize) give a quick read of what and how bright before the text.
 */

import { alpha, color } from "@/theme";
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { planetDotSize, type PlanetView } from "@/ar";

/** MaterialCommunityIcons glyph for each body: sun, moon, or a filled dot for the planets. */
function glyphForBody(body: string): keyof typeof MaterialCommunityIcons.glyphMap {
  if (body === "Sun") return "white-balance-sunny";
  if (body === "Moon") return "moon-full";
  return "circle";
}

export interface PlanetLabelProps {
  planet: PlanetView;
  /** Pixel x of the projected point (label anchor). */
  x: number;
  /** Pixel y after declutter. */
  y: number;
  /** Original anchor y before the declutter push, for the leader line back to the true point. */
  anchorY: number;
  onPress: (body: string) => void;
}

function PlanetLabelBase({ planet, x, y, anchorY, onPress }: PlanetLabelProps) {
  const title = planet.name.trim() || planet.body;
  const mag = planet.magnitude != null ? `${planet.magnitude.toFixed(1)}m` : null;
  const dot = planetDotSize(planet.magnitude);
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
        testID={`planet-label-${planet.body}`}
        onPress={() => onPress(planet.body)}
        style={[styles.label, { left: x, top: y }]}
        hitSlop={8}
      >
        <View style={styles.tick} />
        <View style={styles.titleRow}>
          <MaterialCommunityIcons
            testID={`planet-icon-${planet.body}`}
            name={glyphForBody(planet.body)}
            size={dot}
            color={color.entity.sky}
            style={styles.icon}
          />
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        </View>
        {mag ? (
          <Text style={styles.sub} numberOfLines={1}>
            {mag}
          </Text>
        ) : null}
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  label: {
    position: "absolute",
    transform: [{ translateX: -6 }, { translateY: -6 }],
    // Dark, faintly gold-tinted backing so the sky labels sit apart from the blue/teal/violet chips.
    backgroundColor: "rgba(30, 24, 8, 0.72)",
    borderColor: alpha(color.entity.sky, 0.8),
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    maxWidth: 150,
  },
  // sky = triangle — a colourblind-safe shape, distinct from aircraft circle / vessel square / sat diamond.
  tick: {
    position: "absolute",
    left: -5,
    top: -6,
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderBottomWidth: 9,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: color.entity.sky,
    backgroundColor: "transparent",
  },
  titleRow: { flexDirection: "row", alignItems: "center" },
  icon: { marginRight: 4 },
  title: { color: "#FBEFD0", fontSize: 12, fontWeight: "600" },
  sub: { color: "#E7CE93", fontSize: 10 },
  leader: {
    position: "absolute",
    width: StyleSheet.hairlineWidth,
    backgroundColor: alpha(color.entity.sky, 0.5),
    pointerEvents: "none",
  },
});

export const PlanetLabel = memo(PlanetLabelBase);
