/**
 * The cockpit view's place card: what an airport / port / ferry-quay label in the 3D scene stands for,
 * opened by tapping the label or its point. Deliberately lighter than the traffic detail card: one small
 * box at the bottom-left (the screen positions it clear of the HUD and the control column), no actions,
 * just the full name, what it is, its codes, the distance and bearing from the followed object, and the
 * data credit (ODbL for OpenStreetMap ports). Closed by its ×, a tap on empty scene, Escape on the web
 * or Android back (the screen handles that one). Data: only the places the label fetch already brought.
 */

import { useEffect } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import type { OverlayPlace } from "@/sim/overlay";
import { placeDetailText, placeRangeText } from "@/sim/place";
import { alpha, color, font, radius, space } from "@/theme";

export interface SimPlaceCardProps {
  place: OverlayPlace;
  /** The followed object's position (distance and bearing are from it), or null while unknown. */
  origin: { lat: number; lon: number } | null;
  onClose: () => void;
  /** Position and width, from the screen's layout. */
  style?: StyleProp<ViewStyle>;
  onLayout?: (e: LayoutChangeEvent) => void;
}

function accentOf(kind: OverlayPlace["kind"]): string {
  return kind === "airport" ? color.airport : kind === "ferry" ? color.ferry : color.port;
}

export function SimPlaceCard({ place, origin, onClose, style, onLayout }: SimPlaceCardProps) {
  // Escape closes it on the web, like the detail sheets.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const accent = accentOf(place.kind);
  const range = placeRangeText(place, origin);
  return (
    <View
      testID="sim-place-card"
      role="dialog"
      aria-label={place.name || place.code}
      style={[styles.card, { borderColor: alpha(accent, 0.7) }, style]}
      onLayout={onLayout}
    >
      <View style={styles.header}>
        <View style={[styles.dot, { backgroundColor: accent }]} />
        <Text testID="sim-place-name" style={styles.name} numberOfLines={2}>
          {place.name || place.code}
        </Text>
        <Pressable
          testID="sim-place-close"
          role="button"
          aria-label="Close"
          accessibilityLabel="Close"
          hitSlop={10}
          style={styles.close}
          onPress={onClose}
        >
          <Text style={styles.closeText}>×</Text>
        </Pressable>
      </View>
      <Text testID="sim-place-kind" style={[styles.detail, { color: accent }]} numberOfLines={1}>
        {placeDetailText(place)}
      </Text>
      {range ? (
        <Text testID="sim-place-range" style={styles.range}>
          {range}
        </Text>
      ) : null}
      {place.credit ? (
        <Text testID="sim-place-credit" style={styles.credit} numberOfLines={1}>
          {place.credit}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    backgroundColor: color.sheetSurface,
    borderWidth: 1,
    borderRadius: radius.card,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    gap: space.xxs,
  },
  header: { flexDirection: "row", alignItems: "center", gap: space.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { flex: 1, color: color.text, fontSize: font.control, fontWeight: "700" },
  close: { paddingHorizontal: space.xs },
  closeText: { color: color.textDim, fontSize: 20, lineHeight: 22, fontWeight: "600" },
  detail: { fontSize: font.label, fontWeight: "600" },
  range: { color: color.text, fontSize: font.body, fontVariant: ["tabular-nums"] },
  credit: { color: color.textMuted, fontSize: font.micro },
});
