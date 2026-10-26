/**
 * Floating chip on the Map while a target is focused: "Following SAS4123", "SAS4123 (tap to follow)"
 * after the user has panned away, or "SAS4123: signal lost" when it has left the feed. Tapping the
 * label re-centres and resumes following; ✕ clears the focus. Plain RN, shared by native and web.
 */

import { alpha, color } from "@/theme";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { FocusTarget } from "./focus";

export interface MapFocusChipProps {
  target: FocusTarget;
  following: boolean;
  onFollow: () => void;
  onClear: () => void;
}

export function MapFocusChip({ target, following, onFollow, onClear }: MapFocusChipProps) {
  const accent = target.kind === "aircraft" ? color.entity.air : color.entity.sea;
  const status =
    target.position == null
      ? `${target.label}: signal lost`
      : following
        ? `Following ${target.label}`
        : `${target.label} (tap to follow)`;
  return (
    <View style={[styles.chip, { borderColor: accent }]}>
      <Pressable testID="map-focus-follow" onPress={onFollow} disabled={target.position == null}>
        <Text style={[styles.text, { color: accent }]} numberOfLines={1}>
          ◎ {status}
        </Text>
      </Pressable>
      <Pressable testID="map-focus-clear" onPress={onClear} hitSlop={8}>
        <Text style={[styles.text, { color: accent }]}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    position: "absolute",
    top: 12,
    // Web: clear Leaflet's top-left zoom buttons (10 px inset + 34 px wide).
    left: Platform.OS === "web" ? 56 : 12,
    // Above Leaflet's panes (z-index 400-700) on web; no effect on native.
    zIndex: 1000,
    maxWidth: "70%",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: alpha(color.bg, 0.9),
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  text: { fontSize: 13, fontWeight: "700" },
});
