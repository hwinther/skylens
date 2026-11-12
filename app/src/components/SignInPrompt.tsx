/**
 * Sign-in card for live mode when the backend requires a sign-in and there is no session. Without
 * it the app made no API calls and the user only saw "disconnected". Offers the sign-in itself and
 * a way back to demo mode (recorded traffic + on-device sky, no API calls).
 *
 * Mounted once in the root layout, next to ApiIssueBanner, so it floats above every tab. Hidden on
 * the routes that are part of signing in (the web OAuth popup mounts this same layout at /oauth).
 */

import { usePathname } from "expo-router";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/auth/useAuth";
import { useApiAccess, useAuthStore } from "@/state/authStore";
import { useSettingsStore } from "@/state/settingsStore";
import { alpha, color } from "@/theme";

/** Routes where the card would be in the way: they are the sign-in flow (or precede it). */
const HIDDEN_ON = ["/sign-in", "/oauth", "/onboarding"];

/** Same clearance ApiIssueBanner uses: just above the default tab bar. */
const TAB_BAR_CLEARANCE = 64;

/** True when the sign-in card is on screen (ApiIssueBanner steps aside for it). */
export function useSignInPromptVisible(): boolean {
  const demoMode = useSettingsStore((s) => s.demoMode);
  const access = useApiAccess();
  const pathname = usePathname();
  return !demoMode && access === "sign-in-required" && !HIDDEN_ON.includes(pathname);
}

export function SignInPrompt() {
  // The card's body (and with it useAuth's IdP discovery fetch) only mounts while it is shown, so
  // environments that never need a sign-in never contact the IdP.
  return useSignInPromptVisible() ? <SignInPromptCard /> : null;
}

function SignInPromptCard() {
  const insets = useSafeAreaInsets();
  const { signIn, status, loading } = useAuth();
  const lastError = useAuthStore((s) => s.lastError);
  const setDemoMode = useSettingsStore((s) => s.setDemoMode);
  const busy = status === "authenticating";

  return (
    <View
      testID="signin-prompt"
      accessibilityRole="alert"
      style={[styles.card, { bottom: insets.bottom + TAB_BAR_CLEARANCE }]}
    >
      <Text style={styles.title}>Sign in to see live traffic</Text>
      <Text style={styles.body}>
        Live aircraft, ships, airports and satellites come from the Skylens server, which needs a
        wsh.no account. Demo mode replays recorded traffic without one.
      </Text>
      {lastError ? (
        <Text testID="signin-prompt-error" style={styles.error}>
          {lastError}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable
          testID="signin-prompt-signin"
          accessibilityRole="button"
          disabled={busy || loading}
          // No await before signIn(): the web popup must open inside this press.
          onPress={() => void signIn()}
          style={[styles.button, styles.primary, (busy || loading) && styles.disabled]}
        >
          {busy ? (
            <ActivityIndicator color={color.text} />
          ) : (
            <Text style={styles.primaryText}>{loading ? "Loading…" : "Sign in"}</Text>
          )}
        </Pressable>
        <Pressable
          testID="signin-prompt-demo"
          accessibilityRole="button"
          onPress={() => setDemoMode(true)}
          style={[styles.button, styles.secondary]}
        >
          <Text style={styles.secondaryText}>Continue in demo</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    left: 12,
    right: 12,
    maxWidth: 520,
    marginHorizontal: "auto",
    // Above the tab screens and Leaflet's panes (z-index 400-700), like ApiIssueBanner.
    zIndex: 2000,
    elevation: 12,
    gap: 10,
    backgroundColor: alpha(color.bg, 0.96),
    borderWidth: 1,
    borderColor: color.entity.air,
    borderRadius: 12,
    padding: 16,
  },
  title: { color: color.text, fontSize: 17, fontWeight: "700" },
  body: { color: color.textDim, fontSize: 13, lineHeight: 18 },
  error: { color: color.status.error, fontSize: 13, fontWeight: "600" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 4 },
  button: {
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 18,
    minWidth: 120,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: color.accentFill },
  disabled: { opacity: 0.6 },
  primaryText: { color: color.text, fontSize: 15, fontWeight: "700" },
  secondary: { borderWidth: 1, borderColor: color.surface2 },
  secondaryText: { color: color.textDim, fontSize: 15, fontWeight: "600" },
});
