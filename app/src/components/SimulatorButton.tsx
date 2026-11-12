/**
 * "Cockpit view" action for the aircraft, vessel and satellite detail sheets: starts a simulator session
 * for the target (simStore), closes the sheet and opens the /sim route. Same handoff and styling as
 * ShowOnMapButton. Shown on the web and on Android (the Android screen runs the same Cesium globe in a
 * DOM-component webview and has its own loading/failure states); hidden on iOS, which is not a target
 * and has never been tried.
 */

import { alpha } from "@/theme";
import { Platform, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { useRouter } from "expo-router";
import { useSimStore, type SimTarget } from "@/state/simStore";

/** Where the cockpit view exists. */
const SIM_PLATFORMS: ReadonlySet<string> = new Set(["web", "android"]);

export interface SimulatorButtonProps {
  target: SimTarget;
  /** Entity family accent (color.entity.air / .sea / .orbit). */
  accent: string;
  onClose: () => void;
  testID?: string;
  /** Layout override, e.g. the detail card's compact action row. */
  style?: StyleProp<ViewStyle>;
}

export function SimulatorButton({ target, accent, onClose, testID, style }: SimulatorButtonProps) {
  const router = useRouter();
  const start = useSimStore((s) => s.start);
  if (!SIM_PLATFORMS.has(Platform.OS)) return null;
  return (
    <Pressable
      testID={testID}
      style={[styles.button, { backgroundColor: alpha(accent, 0.16), borderColor: accent }, style]}
      onPress={() => {
        start(target);
        onClose();
        router.push({ pathname: "/sim", params: { kind: target.kind, id: target.id } });
      }}
    >
      <Text style={[styles.text, { color: accent }]}>Cockpit view</Text>
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
