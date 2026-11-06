/**
 * Native placeholder for the simulator. The cockpit view is web-only in this phase (Cesium needs a
 * browser); Android follows as an Expo DOM component. SimulatorButton hides the entry point on native,
 * so this only shows on a deep link.
 */

import { color } from "@/theme";
import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSimStore } from "@/state/simStore";

export default function SimScreen() {
  const router = useRouter();
  const stop = useSimStore((s) => s.stop);
  useEffect(() => stop, [stop]);

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Cockpit view</Text>
      <Text style={styles.text}>Coming to Android soon. Use the web app for now.</Text>
      <Pressable style={styles.button} onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}>
        <Text style={styles.buttonText}>Back</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  title: { color: color.text, fontSize: 22, fontWeight: "700" },
  text: { color: color.textDim, fontSize: 15, textAlign: "center" },
  button: { marginTop: 12, backgroundColor: color.accentFill, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 24 },
  buttonText: { color: color.text, fontSize: 15, fontWeight: "600" },
});
