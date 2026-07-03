/**
 * The AR status strip: GPS fix quality, heading accuracy, feed source badge, and
 * connection state. Sits at the top of the AR view so the operator can trust (or
 * distrust) the overlay at a glance.
 */

import { StyleSheet, Text, View } from "react-native";
import type { ConnectionState, FeedSource } from "@/state/aircraftStore";
import { CompassCalibration } from "./CompassCalibration";

export interface StatusStripProps {
  gpsAccuracyM: number | null;
  headingAccuracy: number;
  azimuthTrimDeg: number;
  source: FeedSource;
  connection: ConnectionState;
  aircraftCount: number;
}

const CONNECTION_COLOR: Record<ConnectionState, string> = {
  connected: "#7CFC9A",
  connecting: "#FFD37C",
  reconnecting: "#FFD37C",
  disconnected: "#FF8A80",
};

export function StatusStrip({
  gpsAccuracyM,
  headingAccuracy,
  azimuthTrimDeg,
  source,
  connection,
  aircraftCount,
}: StatusStripProps) {
  const gpsText =
    gpsAccuracyM == null ? "GPS: no fix" : `GPS: ±${Math.round(gpsAccuracyM)} m`;
  const gpsColor = gpsAccuracyM == null ? "#FF8A80" : gpsAccuracyM <= 15 ? "#7CFC9A" : "#FFD37C";

  return (
    <View style={styles.strip}>
      <View style={styles.rowTop}>
        <Badge label={source === "demo" ? "DEMO" : "LIVE"} tone={source === "demo" ? "warn" : "ok"} />
        <View style={styles.connWrap}>
          <View style={[styles.dot, { backgroundColor: CONNECTION_COLOR[connection] }]} />
          <Text style={styles.connText}>{connection}</Text>
        </View>
        <Text testID="status-aircraft-count" style={styles.count}>
          {aircraftCount} ac
        </Text>
      </View>
      <View style={styles.rowBottom}>
        <View style={styles.gpsWrap}>
          <View style={[styles.dot, { backgroundColor: gpsColor }]} />
          <Text style={styles.gpsText}>{gpsText}</Text>
        </View>
        <CompassCalibration headingAccuracy={headingAccuracy} azimuthTrimDeg={azimuthTrimDeg} />
      </View>
    </View>
  );
}

function Badge({ label, tone }: { label: string; tone: "ok" | "warn" }) {
  return (
    <View style={[styles.badge, tone === "warn" ? styles.badgeWarn : styles.badgeOk]}>
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    backgroundColor: "rgba(11, 22, 34, 0.6)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowBottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  connWrap: { flexDirection: "row", alignItems: "center" },
  gpsWrap: { flexDirection: "row", alignItems: "center" },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  connText: { color: "#EAF6FF", fontSize: 12, textTransform: "capitalize" },
  gpsText: { color: "#EAF6FF", fontSize: 12 },
  count: { color: "#9FC7E0", fontSize: 12 },
  badge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  badgeOk: { backgroundColor: "rgba(124, 252, 154, 0.2)" },
  badgeWarn: { backgroundColor: "rgba(255, 180, 80, 0.25)" },
  badgeText: { color: "#EAF6FF", fontSize: 11, fontWeight: "700" },
});
