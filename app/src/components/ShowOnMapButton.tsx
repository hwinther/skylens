/**
 * "Show on map" action for the aircraft and vessel detail sheets: hands the target to the Map via
 * mapFocusStore, closes the sheet and routes to the Map tab, which centres on and follows it. Same
 * handoff and styling as SatelliteDetailSheet's "Show ground track", tinted per entity family.
 */

import { alpha } from "@/theme";
import { Pressable, StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import { useMapFocusStore, type MapFocus } from "@/state/mapFocusStore";

export interface ShowOnMapButtonProps {
  focus: MapFocus;
  /** Entity family accent (color.entity.air / .sea). */
  accent: string;
  onClose: () => void;
  testID?: string;
}

export function ShowOnMapButton({ focus, accent, onClose, testID }: ShowOnMapButtonProps) {
  const router = useRouter();
  const setFocus = useMapFocusStore((s) => s.setFocus);
  return (
    <Pressable
      testID={testID}
      style={[styles.button, { backgroundColor: alpha(accent, 0.16), borderColor: accent }]}
      onPress={() => {
        setFocus(focus);
        onClose();
        router.push("/map");
      }}
    >
      <Text style={[styles.text, { color: accent }]}>Show on map</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    marginTop: 12,
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  text: { fontSize: 15, fontWeight: "700" },
});
