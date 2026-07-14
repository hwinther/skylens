/**
 * Trust-indicator legend: explains what the AR status strip's signals mean (GPS accuracy, compass
 * confidence, the DEMO badge). One source of truth, reused in the onboarding intro (step 3) and
 * opened later from the status strip's info glyph — so users who skip onboarding can still learn it.
 */
import { color } from "@/theme";
import { StyleSheet, Text, View } from "react-native";

export function TrustLegend() {
  return (
    <View style={styles.wrap}>
      <Row
        dot={color.status.ok}
        title="GPS ±8 m"
        body="Position accuracy. Under ±15 m is green; higher goes amber — labels drift more when it does."
      />
      <Row
        dot={color.status.warn}
        title="Compass: Low"
        body="Heading confidence (Unreliable → High). If low, wave the phone in a figure-8 or nudge Azimuth trim."
      />
      <Row
        dot={color.status.warn}
        title="DEMO badge"
        body="You're seeing replayed traffic, not the live sky. Switch to Live in Settings when you're outdoors."
      />
    </View>
  );
}

function Row({ dot, title, body }: { dot: string; title: string; body: string }) {
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <View style={styles.rowBody}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12, backgroundColor: color.surface, borderRadius: 12, padding: 14 },
  row: { flexDirection: "row", gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  rowBody: { flex: 1, gap: 2 },
  title: { color: color.text, fontSize: 14, fontWeight: "700" },
  body: { color: color.textDim, fontSize: 13, lineHeight: 19 },
});
