/**
 * App-wide banner for the latest REST failure the user should know about (see apiIssueStore): an
 * expired session, an edge block, a server error or no connection. Without it a failing layer just
 * drew nothing. Floats above every tab, just over the tab bar; an auth issue offers a shortcut to the
 * sign-in screen. While the sign-in card (SignInPrompt) is up it already says the same, so an auth
 * issue steps aside for it.
 */

import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { describeApiIssue, useApiIssueStore } from "@/state/apiIssueStore";
import { useApiAccess } from "@/state/authStore";
import { useSignInPromptVisible } from "./SignInPrompt";
import { alpha, color } from "@/theme";

/**
 * Bottom placement, just above the tab bar: at the top it covered the screens' own controls (the
 * Radar/Map toggle, the AR status strip). The banner lives outside the Tabs navigator, so it can't
 * read the tab bar height; this clears the default bar.
 */
const TAB_BAR_CLEARANCE = 64;

export function ApiIssueBanner() {
  const issue = useApiIssueStore((s) => s.issue);
  const dismiss = useApiIssueStore((s) => s.dismiss);
  const insets = useSafeAreaInsets();
  const signedOut = useApiAccess() === "sign-in-required";
  const promptVisible = useSignInPromptVisible();
  if (!issue) return null;
  if (issue.kind === "auth" && promptVisible) return null;

  const tint = issue.kind === "network" || issue.kind === "server" ? color.status.warn : color.status.error;

  return (
    <View
      testID="api-issue-banner"
      accessibilityRole="alert"
      style={[styles.banner, { bottom: insets.bottom + TAB_BAR_CLEARANCE, borderColor: tint }]}
    >
      <Text testID="api-issue-text" style={[styles.text, { color: tint }]}>
        {describeApiIssue(issue, { signedOut })}
      </Text>
      {issue.kind === "auth" ? (
        <Pressable
          testID="api-issue-signin"
          onPress={() => {
            dismiss();
            router.push("/sign-in");
          }}
          style={styles.action}
        >
          <Text style={[styles.actionText, { color: tint }]}>Sign in</Text>
        </Pressable>
      ) : null}
      <Pressable testID="api-issue-dismiss" onPress={() => dismiss()} hitSlop={8} style={styles.action}>
        <Text style={styles.close}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: "absolute",
    left: 12,
    right: 12,
    // Above the tab screens and Leaflet's panes (z-index 400-700).
    zIndex: 2000,
    elevation: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: alpha(color.bg, 0.95),
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  text: { flex: 1, fontSize: 13, fontWeight: "600" },
  action: { paddingHorizontal: 4, paddingVertical: 2 },
  actionText: { fontSize: 13, fontWeight: "800", textDecorationLine: "underline" },
  close: { color: color.textDim, fontSize: 15, fontWeight: "700" },
});
