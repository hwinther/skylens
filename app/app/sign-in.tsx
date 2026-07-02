/**
 * Sign-in screen. In real mode it kicks off the expo-auth-session PKCE flow against
 * auth.wsh.no; in mock mode it mints a fake token so the app is usable in Expo Go
 * before the custom-scheme dev build exists. On success it routes back to the AR view.
 */

import { useEffect } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@/auth/useAuth";
import { useAuthStore } from "@/state/authStore";

export default function SignInScreen() {
  const { signIn } = useAuth();
  const status = useAuthStore((s) => s.status);
  const mockMode = useAuthStore((s) => s.mockMode);

  useEffect(() => {
    if (status === "authenticated") router.replace("/");
  }, [status]);

  return (
    <View style={styles.root}>
      <Text style={styles.brand}>Skylens</Text>
      <Text style={styles.tagline}>Point at the sky. See what&apos;s flying.</Text>

      {status === "authenticating" ? (
        <ActivityIndicator color="#78C8FF" />
      ) : (
        <Pressable style={styles.button} onPress={() => void signIn()}>
          <Text style={styles.buttonText}>
            {mockMode ? "Continue (mock)" : "Sign in with wsh.no"}
          </Text>
        </Pressable>
      )}

      {mockMode && (
        <Text style={styles.note}>
          Mock mode is on — sign-in is simulated. Turn it off in Settings once the dev
          build is installed.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B1622", alignItems: "center", justifyContent: "center", padding: 24 },
  brand: { color: "#EAF6FF", fontSize: 40, fontWeight: "800", letterSpacing: 1 },
  tagline: { color: "#9FC7E0", fontSize: 15, marginTop: 8, marginBottom: 40 },
  button: {
    backgroundColor: "#12507a",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 28,
  },
  buttonText: { color: "#EAF6FF", fontSize: 17, fontWeight: "600" },
  note: { color: "#5c7a94", fontSize: 12, textAlign: "center", marginTop: 24, maxWidth: 300 },
});
