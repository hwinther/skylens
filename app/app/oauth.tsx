/**
 * OAuth redirect target for `makeRedirectUri({ scheme: "skylens", path: "oauth" })`.
 *
 * Web: Authelia redirects the sign-in popup to `${origin}/oauth`; the root layout's
 * module-scope `WebBrowser.maybeCompleteAuthSession()` posts the response back to the opener
 * and closes the popup, so this screen is just the brief "please wait" shown inside it.
 *
 * Native: `AuthSession.promptAsync()` already catches the `skylens://oauth?code=…` redirect,
 * exchanges the code, and marks the session authenticated (see `useAuth.signIn`). But on a
 * standalone build the OS ALSO delivers that custom-scheme URL to the app as a deep link, and
 * expo-router renders this route on top — stranding the user on "Completing sign-in…" while the
 * app is actually signed in behind it. So on native we immediately bounce home; the exchange is
 * driven by promptAsync independently of the route, so nothing here needs the code/verifier.
 *
 * Native, with no sign-in waiting for the redirect: Android may stop the app while the Custom Tab is
 * open, and the redirect then starts it fresh on this route. The PKCE verifier lived only in the old
 * process, so the code cannot be exchanged; say so (the sign-in surfaces show it) instead of
 * landing signed out with no explanation. The code itself is never used or logged here.
 */

import { color } from "@/theme";
import { useEffect } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SIGN_IN_INTERRUPTED_MESSAGE } from "@/auth/errors";
import { isSignInInFlight } from "@/auth/useAuth";
import { useAuthStore } from "@/state/authStore";

export default function OAuthRedirectScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string; error?: string }>();
  const isRedirect = params.code != null || params.error != null;
  useEffect(() => {
    if (Platform.OS === "web") return;
    const auth = useAuthStore.getState();
    if (isRedirect && !isSignInInFlight() && auth.status !== "authenticated") {
      auth.setLastError(SIGN_IN_INTERRUPTED_MESSAGE);
    }
    router.replace("/");
  }, [router, isRedirect]);

  return (
    <View style={styles.root}>
      <ActivityIndicator color={color.entity.air} />
      <Text style={styles.text}>Completing sign-in…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.bg,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
  },
  text: { color: color.textDim, fontSize: 15 },
});

export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteErrorBoundary";
