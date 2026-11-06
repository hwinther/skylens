/**
 * "Cockpit view" action for the aircraft, vessel and satellite detail sheets: starts a simulator session
 * for the target (simStore), closes the sheet and opens the /sim route. Same handoff and styling as
 * ShowOnMapButton. Web only for now; the Android simulator is a later phase, so the button renders
 * nothing on native.
 */

import { alpha } from "@/theme";
import { Platform, Pressable, StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import { useSimStore, type SimTarget } from "@/state/simStore";

export interface SimulatorButtonProps {
  target: SimTarget;
  /** Entity family accent (color.entity.air / .sea / .orbit). */
  accent: string;
  onClose: () => void;
  testID?: string;
}

export function SimulatorButton({ target, accent, onClose, testID }: SimulatorButtonProps) {
  const router = useRouter();
  const start = useSimStore((s) => s.start);
  if (Platform.OS !== "web") return null;
  return (
    <Pressable
      testID={testID}
      style={[styles.button, { backgroundColor: alpha(accent, 0.16), borderColor: accent }]}
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
