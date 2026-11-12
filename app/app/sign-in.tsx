/**
 * Sign-in screen. In real mode it kicks off the expo-auth-session PKCE flow against
 * auth.wsh.no; in mock mode (dev only) it mints a fake token so the app is usable in Expo Go
 * before the custom-scheme dev build exists. On success it goes back to where the user came from
 * (or the AR view). "Continue in demo" switches to demo mode, which needs no account.
 */

import { color } from "@/theme";
import { useEffect } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@/auth/useAuth";
import { useAuthStore } from "@/state/authStore";
import { useSettingsStore } from "@/state/settingsStore";

function leave() {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

export default function SignInScreen() {
  const { signIn, ready, loading } = useAuth();
  const status = useAuthStore((s) => s.status);
  const mockMode = useAuthStore((s) => s.mockMode);
  const lastError = useAuthStore((s) => s.lastError);
  const setDemoMode = useSettingsStore((s) => s.setDemoMode);

  useEffect(() => {
    if (status === "authenticated") leave();
  }, [status]);

  return (
    <View style={styles.root}>
      <Text style={styles.brand}>Skylens</Text>
      <Text style={styles.tagline}>Point at the sky. See what&apos;s flying.</Text>

      {status === "authenticating" ? (
        <ActivityIndicator color={color.entity.air} />
      ) : (
        <Pressable
          testID="signin-screen-signin"
          accessibilityRole="button"
          // Disabled only while the IdP discovery is still loading; once it failed, a press reports
          // the problem and retries it.
          disabled={!ready && loading}
          style={[styles.button, !ready && loading && styles.disabled]}
          // No await before signIn(): the web popup must open inside this press.
          onPress={() => void signIn()}
        >
          <Text style={styles.buttonText}>
            {!ready && loading ? "Loading…" : mockMode ? "Continue (mock)" : "Sign in with wsh.no"}
          </Text>
        </Pressable>
      )}

      {lastError ? (
        <Text testID="signin-screen-error" style={styles.error}>
          {lastError}
        </Text>
      ) : null}

      <Pressable
        testID="signin-screen-demo"
        accessibilityRole="button"
        style={styles.secondary}
        onPress={() => {
          setDemoMode(true);
          leave();
        }}
      >
        <Text style={styles.secondaryText}>Continue in demo</Text>
      </Pressable>

      {__DEV__ && mockMode && (
        <Text style={styles.note}>
          Mock mode is on — sign-in is simulated. Turn it off in Settings once the dev
          build is installed.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg, alignItems: "center", justifyContent: "center", padding: 24 },
  brand: { color: color.text, fontSize: 40, fontWeight: "800", letterSpacing: 1 },
  tagline: { color: color.textDim, fontSize: 15, marginTop: 8, marginBottom: 40 },
  button: {
    backgroundColor: color.accentFill,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 28,
  },
  disabled: { opacity: 0.6 },
  buttonText: { color: color.text, fontSize: 17, fontWeight: "600" },
  error: {
    color: color.status.error,
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
    marginTop: 16,
    maxWidth: 360,
  },
  secondary: { marginTop: 20, paddingVertical: 10, paddingHorizontal: 20 },
  secondaryText: { color: color.textDim, fontSize: 15, fontWeight: "600", textDecorationLine: "underline" },
  note: { color: color.textMuted, fontSize: 12, textAlign: "center", marginTop: 24, maxWidth: 300 },
});
