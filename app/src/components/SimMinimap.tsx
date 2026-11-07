/**
 * Cockpit-view minimap (web only — imported solely from SimScreen.web.tsx, like LeafletMap, so the
 * leaflet import never reaches Hermes): a small, non-interactive OpenStreetMap inset that keeps the followed
 * object centred, with an arrow pointing along its direction of travel — "where am I" at a glance, like
 * a game minimap. Tapping it hands the target to the full Map. Leaflet tiles are already allowed by the
 * CSP (the web Map uses them), so this adds no new hosts.
 */

import { alpha, color } from "@/theme";
import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { MapContainer, TileLayer, useMap } from "react-leaflet";

export interface SimMinimapProps {
  lat: number;
  lon: number;
  headingDeg: number;
  zoom: number;
  /** Accent for the arrow (the object's family colour). */
  accent: string;
  onPress?: () => void;
}

const SIZE = 168;

/** Re-centre on every pose update without animation (the HUD ticks at 4 Hz). */
function Follow({ lat, lon, zoom }: { lat: number; lon: number; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lon], zoom, { animate: false });
  }, [map, lat, lon, zoom]);
  return null;
}

export function SimMinimap({ lat, lon, headingDeg, zoom, accent, onPress }: SimMinimapProps) {
  return (
    <View style={styles.frame} testID="sim-minimap">
      <MapContainer
        center={[lat, lon]}
        zoom={zoom}
        style={{ width: SIZE, height: SIZE }}
        zoomControl={false}
        dragging={false}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        touchZoom={false}
        boxZoom={false}
        keyboard={false}
        attributionControl={false}
      >
        <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} />
        <Follow lat={lat} lon={lon} zoom={zoom} />
      </MapContainer>
      {/* The arrow is a fixed overlay at the centre: the map moves under it, it only rotates. */}
      <View style={styles.arrowWrap} pointerEvents="none">
        <MaterialCommunityIcons
          testID="sim-minimap-arrow"
          name="navigation"
          size={26}
          color={accent}
          style={[styles.arrow, { transform: [{ rotate: `${headingDeg}deg` }] }]}
        />
      </View>
      {/* Small credit, as the full map shows (OSM tiles require it). */}
      <View style={styles.credit} pointerEvents="none">
        <MaterialCommunityIcons name="copyright" size={8} color={color.textDim} />
        <Text style={styles.creditText}>OpenStreetMap</Text>
      </View>
      {onPress ? (
        <Pressable
          testID="sim-minimap-open"
          accessibilityRole="button"
          accessibilityLabel="Open on the map"
          style={[StyleSheet.absoluteFill, styles.tapTarget]}
          onPress={onPress}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    position: "absolute",
    right: 16,
    bottom: 32,
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: alpha(color.text, 0.6),
    backgroundColor: color.bg,
  },
  // Leaflet's panes sit at z-index 400+ inside the frame, so everything drawn over the map needs a
  // higher one or it ends up under the tiles.
  arrowWrap: {
    zIndex: 1000,
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  arrow: { textShadowColor: "#000", textShadowRadius: 3 },
  credit: {
    zIndex: 1000,
    position: "absolute",
    bottom: 10,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: alpha(color.bg, 0.6),
    paddingHorizontal: 3,
    borderRadius: 3,
  },
  creditText: { color: color.textDim, fontSize: 8 },
  tapTarget: { zIndex: 1001 },
});
