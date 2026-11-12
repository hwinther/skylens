/**
 * Per-route error boundary. Every route file in app/ re-exports this as its `ErrorBoundary`, which
 * expo-router wraps around that route only: a render crash in one screen shows this fallback inside
 * that screen while the tab bar and the other tabs keep working.
 *
 * The crash is reported once per error through the client-log buffer (POST /api/client-log, the same
 * open endpoint the failed-request summaries use), so it lands in the backend logs. Only the error's
 * name, a scrubbed and truncated message, and the route path are sent: no stack, no query string, and
 * anything token-shaped is redacted first.
 */
import { color } from "@/theme";
import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router, usePathname, type ErrorBoundaryProps } from "expo-router";
import { flushClientLog, reportClientFailure } from "@/api/clientLog";
import { getApiBaseUrl } from "@/api/config";

const MAX_DETAIL = 300;

// Errors already reported. Module-level (not a ref) so a remount of the same fallback, or React's
// dev double-invoked effects, still report each error once.
const reported = new WeakSet<Error>();

/**
 * The loggable summary of a render error: "Name: message", with JWTs, bearer tokens, token/code
 * query parameters and long opaque runs redacted, truncated to MAX_DETAIL. Exported for tests.
 */
export function renderErrorDetail(error: Error): string {
  const raw = `${error.name || "Error"}: ${error.message ?? ""}`;
  const scrubbed = raw
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[redacted]")
    .replace(/\b(bearer)\s+\S+/gi, "$1 [redacted]")
    .replace(/\b((?:access_|refresh_|id_)?token|code|code_verifier|state)=[^&\s]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, "[redacted]");
  return scrubbed.length > MAX_DETAIL ? `${scrubbed.slice(0, MAX_DETAIL - 1)}…` : scrubbed;
}

export function RouteErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const pathname = usePathname();

  useEffect(() => {
    if (reported.has(error)) return;
    reported.add(error);
    reportClientFailure({
      method: "RENDER",
      endpoint: pathname || "/",
      status: null,
      edgeMarkerPresent: false,
      detail: renderErrorDetail(error),
    });
    void flushClientLog(getApiBaseUrl());
  }, [error, pathname]);

  const goHome = () => {
    router.replace("/");
    void retry();
  };

  return (
    <View testID="route-error" style={styles.root}>
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.body}>This screen hit an error. The rest of the app still works.</Text>
      {error.message ? (
        <Text testID="route-error-message" style={styles.detail} numberOfLines={3}>
          {error.message}
        </Text>
      ) : null}
      <Pressable
        testID="route-error-retry"
        accessibilityRole="button"
        onPress={() => void retry()}
        style={styles.button}
      >
        <Text style={styles.buttonText}>Try again</Text>
      </Pressable>
      <Pressable
        testID="route-error-home"
        accessibilityRole="button"
        onPress={goHome}
        style={styles.secondary}
      >
        <Text style={styles.secondaryText}>Go to start</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg, alignItems: "center", justifyContent: "center", padding: 24 },
  title: { color: color.text, fontSize: 20, fontWeight: "700", textAlign: "center" },
  body: { color: color.textDim, fontSize: 15, textAlign: "center", marginTop: 8, maxWidth: 320 },
  detail: { color: color.textMuted, fontSize: 12, textAlign: "center", marginTop: 12, maxWidth: 320 },
  button: {
    backgroundColor: color.accentFill,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 28,
  },
  buttonText: { color: color.text, fontSize: 16, fontWeight: "600" },
  secondary: { marginTop: 16, padding: 8 },
  secondaryText: { color: color.textDim, fontSize: 15, fontWeight: "600", textDecorationLine: "underline" },
});
