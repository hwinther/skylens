/**
 * Web OAuth redirect target. `makeRedirectUri({ scheme: "skylens", path: "oauth" })`
 * resolves to `${window.location.origin}/oauth` on web, so Authelia redirects the sign-in
 * popup here after the user authenticates. The root layout's module-scope
 * `WebBrowser.maybeCompleteAuthSession()` posts the auth response back to the opener window
 * and closes this popup; this screen is only the brief "please wait" the user sees while
 * that happens. It is hidden from the tab bar (`href: null` in _layout) and is a no-op on
 * native, where the OAuth flow never navigates to a route.
 */

import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

export default function OAuthRedirectScreen() {
  return (
    <View style={styles.root}>
      <ActivityIndicator color="#78C8FF" />
      <Text style={styles.text}>Completing sign-in…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0B1622",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
  },
  text: { color: "#9FC7E0", fontSize: 15 },
});
