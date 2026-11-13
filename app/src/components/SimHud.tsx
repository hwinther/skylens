/**
 * The cockpit view's HUD box (name, kind-specific rows, status line), shared by the web screen and the
 * Android screen so both keep the same `sim-*` testIDs. Text comes from src/sim/hud.ts.
 */

import { color } from "@/theme";
import type { ReactNode } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { OrbitClass } from "@/ar/orbitClass";
import { hudRows, type HudRow } from "@/sim/hud";
import type { SimKind } from "@/sim/simPose";
import type { TrackedPose } from "@/sim/tracker";

export interface SimHudProps {
  kind: SimKind;
  name: string;
  pose: TrackedPose | null;
  /** The followed satellite's orbit class, shown next to its altitude. */
  orbitClass?: OrbitClass | null;
  status: string;
  /** Navigation aids under the kind's rows: nearest airport/port, destination (src/sim/route.ts). */
  navRows?: readonly HudRow[];
  style?: StyleProp<ViewStyle>;
  /** Extra lines under the status (e.g. the Android globe's imagery note). */
  children?: ReactNode;
}

export function SimHud({ kind, name, pose, orbitClass, status, navRows, style, children }: SimHudProps) {
  return (
    <View style={[styles.hud, style]} pointerEvents="box-none" testID="sim-hud">
      <Text testID="sim-name" style={styles.name}>
        {name || "…"}
      </Text>
      {pose ? <HudRows kind={kind} pose={pose} orbitClass={kind === "satellite" ? orbitClass : null} /> : null}
      {pose && navRows?.length ? (
        <View style={styles.nav}>
          {navRows.map(([label, value, testID]) => (
            <View key={label} style={styles.row}>
              <Text style={styles.label}>{label}</Text>
              <Text testID={testID} style={styles.navValue} numberOfLines={1}>
                {value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <Text testID="sim-status" style={[styles.status, pose?.stale && styles.lost]}>
        {status}
      </Text>
      {children}
    </View>
  );
}

function HudRows({ kind, pose, orbitClass }: { kind: SimKind; pose: TrackedPose; orbitClass?: OrbitClass | null }) {
  return (
    <View style={styles.rows}>
      {hudRows(kind, pose).map(([label, value, testID]) => (
        <View key={label} style={styles.row}>
          <Text style={styles.label}>{label}</Text>
          {testID === "sim-alt" && orbitClass ? (
            // A sibling, not nested, so sim-alt keeps reading just the altitude.
            <View style={styles.valueGroup}>
              <Text testID="sim-orbit-class" style={styles.orbitClass}>
                {orbitClass}
              </Text>
              <Text testID={testID} style={styles.value}>
                {value}
              </Text>
            </View>
          ) : (
            <Text testID={testID} style={styles.value}>
              {value}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

export const simHudStyles = StyleSheet.create({
  /** Small secondary line under the status (same size, dimmer). */
  note: { color: color.textMuted, fontSize: 12, marginTop: 4 },
});

const styles = StyleSheet.create({
  hud: {
    position: "absolute",
    top: 16,
    left: 16,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "rgba(11, 22, 34, 0.72)",
    minWidth: 180,
  },
  name: { color: color.text, fontSize: 18, fontWeight: "700", marginBottom: 6 },
  rows: { gap: 2 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 16 },
  label: { color: color.textMuted, fontSize: 13, fontWeight: "600" },
  value: { color: color.text, fontSize: 14, fontVariant: ["tabular-nums"] },
  nav: { gap: 2, marginTop: 6, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.textMuted },
  navValue: { color: color.text, fontSize: 13, fontVariant: ["tabular-nums"], flexShrink: 1 },
  valueGroup: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  orbitClass: { color: color.textMuted, fontSize: 12, fontWeight: "700" },
  status: { color: color.textDim, fontSize: 12, marginTop: 8 },
  lost: { color: "#FFB45C" },
});
