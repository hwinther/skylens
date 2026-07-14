/**
 * The AR status strip: GPS fix quality, heading accuracy, feed source badge, and
 * connection state. Sits at the top of the AR view so the operator can trust (or
 * distrust) the overlay at a glance.
 */

import { alpha, color } from "@/theme";
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
  connected: color.status.ok,
  connecting: color.status.warn,
  reconnecting: color.status.warn,
  disconnected: color.status.error,
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
  const gpsColor = gpsAccuracyM == null ? color.status.error : gpsAccuracyM <= 15 ? color.status.ok : color.status.warn;

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
    backgroundColor: alpha(color.bg, 0.82),
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowBottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  connWrap: { flexDirection: "row", alignItems: "center" },
  gpsWrap: { flexDirection: "row", alignItems: "center" },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 6 },
  connText: {
    color: color.text,
    fontSize: 12,
    textTransform: "capitalize",
    textShadowColor: "rgba(0, 0, 0, 0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  gpsText: {
    color: color.text,
    fontSize: 12,
    textShadowColor: "rgba(0, 0, 0, 0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  count: { color: color.textDim, fontSize: 12 },
  badge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  badgeOk: { backgroundColor: alpha(color.status.ok, 0.2) },
  badgeWarn: { backgroundColor: "rgba(255, 180, 80, 0.25)" },
  badgeText: { color: color.text, fontSize: 11, fontWeight: "700" },
});
