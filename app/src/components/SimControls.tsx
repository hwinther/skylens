/**
 * The cockpit view's small controls, shared by the web and Android screens so both keep the same
 * testIDs and accessibility: the outside-view toggle (`sim-camera-toggle`), the "Details" chip that
 * reopens the followed object's card (`sim-details`), and the layer filter — one "Layers" button
 * (`sim-filter`) that unfolds a column of toggle chips (`sim-filter-<layer>`) so it never covers the
 * scene for long. Toggles carry `role` + `aria-pressed` / `aria-expanded` (react-native-web ignores
 * accessibilityState) and the same state as `accessibilityState` for TalkBack, as the List filter does.
 */

import { alpha, color } from "@/theme";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { SimFilterChip, SimLayer } from "@/sim/layers";

export interface SimToggleChipProps {
  testID: string;
  label: string;
  on: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}

/** An on/off chip (the outside view, like the web's Pan/tilt). */
export function SimToggleChip({ testID, label, on, onPress, accessibilityLabel }: SimToggleChipProps) {
  return (
    <Pressable
      testID={testID}
      role="button"
      aria-pressed={on}
      accessibilityState={{ selected: on }}
      aria-label={accessibilityLabel ?? label}
      style={[styles.chip, on && styles.chipOn]}
      onPress={onPress}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

/** A plain action chip (Details, Map). */
export function SimActionChip({ testID, label, onPress, accessibilityLabel }: Omit<SimToggleChipProps, "on">) {
  return (
    <Pressable
      testID={testID}
      role="button"
      aria-label={accessibilityLabel ?? label}
      style={styles.chip}
      onPress={onPress}
    >
      <Text style={styles.chipText}>{label}</Text>
    </Pressable>
  );
}

export interface SimFilterProps {
  chips: readonly SimFilterChip[];
  open: boolean;
  onToggleOpen: () => void;
  onToggleLayer: (layer: SimLayer) => void;
  /** "2 hidden", or "" */
  summary: string;
}

export function SimFilter({ chips, open, onToggleOpen, onToggleLayer, summary }: SimFilterProps) {
  if (chips.length === 0) return null;
  return (
    <View style={styles.filter} pointerEvents="box-none">
      <Pressable
        testID="sim-filter"
        role="button"
        aria-expanded={open}
        accessibilityState={{ expanded: open }}
        aria-label={summary ? `Layers, ${summary}` : "Layers"}
        style={[styles.chip, open && styles.chipOn]}
        onPress={onToggleOpen}
      >
        <Text style={[styles.chipText, open && styles.chipTextOn]}>
          {summary ? `Layers · ${summary}` : "Layers"}
        </Text>
      </Pressable>
      {open ? (
        <View testID="sim-filter-panel" role="group" aria-label="Show in the 3D view" style={styles.panel}>
          {chips.map((c) => (
            <Pressable
              key={c.layer}
              testID={`sim-filter-${c.layer}`}
              role="button"
              aria-pressed={c.shown}
              accessibilityState={{ selected: c.shown }}
              aria-label={c.label}
              onPress={() => onToggleLayer(c.layer)}
              style={({ pressed }) => [
                styles.layer,
                c.shown
                  ? { backgroundColor: alpha(c.color, 0.18), borderColor: alpha(c.color, 0.75) }
                  : styles.layerOff,
                pressed && styles.pressed,
              ]}
            >
              <View
                style={[
                  styles.dot,
                  c.shown ? { backgroundColor: c.color } : { borderColor: alpha(c.color, 0.6), borderWidth: 1.5 },
                ]}
              />
              <Text style={[styles.layerText, !c.shown && styles.layerTextOff]}>{c.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    backgroundColor: "rgba(11, 22, 34, 0.72)",
    borderColor: color.textMuted,
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
    minHeight: 32,
    justifyContent: "center",
  },
  chipOn: { borderColor: color.status.ok },
  chipText: { color: color.textDim, fontSize: 13, fontWeight: "600" },
  chipTextOn: { color: color.status.ok },
  filter: { alignItems: "flex-end", gap: 6 },
  panel: {
    gap: 6,
    padding: 8,
    borderRadius: 12,
    backgroundColor: "rgba(11, 22, 34, 0.86)",
    alignItems: "stretch",
  },
  // 40 px tall: a comfortable touch target, as in the List filter.
  layer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1,
  },
  layerOff: { backgroundColor: "transparent", borderColor: color.handle },
  pressed: { opacity: 0.7 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  layerText: { color: color.text, fontSize: 14, fontWeight: "600" },
  layerTextOff: { color: color.textLabel },
});
