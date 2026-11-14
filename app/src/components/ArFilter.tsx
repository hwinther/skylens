/**
 * The AR view's layer filter (src/state/arFilter.ts): one round "Layers" button (`ar-filter`) stacked
 * just above the identify toggle, so "hide the labels, then identify" is one tap away, that unfolds a
 * small column of toggle chips (`ar-filter-<group>`) plus "Show all" (`ar-filter-reset`) and "Hide all"
 * (`ar-filter-hide-all`). While anything is hidden the button carries a count badge, so a hidden group
 * never looks like a missing feed. The chips follow the cockpit's Layers panel and the List filter:
 * a filled chip with a solid dot is drawn, a hollow chip with a ring is hidden. Toggles carry `role` +
 * `aria-pressed` / `aria-expanded` (react-native-web ignores accessibilityState) and the same state as
 * `accessibilityState` for TalkBack.
 */

import { alpha, color, font, space } from "@/theme";
import { Pressable, StyleSheet, Text, View } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { ArFilterChip, ArGroup } from "@/state/arFilter";

/** Size of the round button (same as the identify toggle below it). */
export const AR_FILTER_BUTTON = 48;

export interface ArFilterProps {
  chips: readonly ArFilterChip[];
  hiddenCount: number;
  open: boolean;
  onToggleOpen: () => void;
  onToggleGroup: (group: ArGroup) => void;
  onShowAll: () => void;
  onHideAll: () => void;
  /** Distance from the bottom of the view to the button (above the identify toggle). */
  bottom: number;
}

export function ArFilter({
  chips,
  hiddenCount,
  open,
  onToggleOpen,
  onToggleGroup,
  onShowAll,
  onHideAll,
  bottom,
}: ArFilterProps) {
  const summary = hiddenCount ? `${hiddenCount} hidden` : "";
  const allHidden = chips.length > 0 && hiddenCount === chips.length;
  return (
    <View style={[styles.wrap, { bottom }]} pointerEvents="box-none">
      {open ? (
        <View testID="ar-filter-panel" role="group" aria-label="Show in AR" style={styles.panel}>
          {chips.map((c) => (
            <Pressable
              key={c.group}
              testID={`ar-filter-${c.group}`}
              role="button"
              aria-pressed={c.shown}
              accessibilityState={{ selected: c.shown }}
              aria-label={c.label}
              onPress={() => onToggleGroup(c.group)}
              style={({ pressed }) => [
                styles.chip,
                c.shown
                  ? { backgroundColor: alpha(c.color, 0.18), borderColor: alpha(c.color, 0.75) }
                  : styles.chipOff,
                pressed && styles.pressed,
              ]}
            >
              <View
                style={[
                  styles.dot,
                  c.shown ? { backgroundColor: c.color } : { borderColor: alpha(c.color, 0.6), borderWidth: 1.5 },
                ]}
              />
              <Text style={[styles.chipText, !c.shown && styles.chipTextOff]}>{c.label}</Text>
            </Pressable>
          ))}
          <View style={styles.actions}>
            <Pressable
              testID="ar-filter-reset"
              role="button"
              aria-disabled={hiddenCount === 0}
              accessibilityState={{ disabled: hiddenCount === 0 }}
              disabled={hiddenCount === 0}
              onPress={onShowAll}
              hitSlop={6}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              <Text style={[styles.actionText, hiddenCount === 0 && styles.actionTextOff]}>Show all</Text>
            </Pressable>
            <Pressable
              testID="ar-filter-hide-all"
              role="button"
              aria-disabled={allHidden}
              accessibilityState={{ disabled: allHidden }}
              disabled={allHidden}
              onPress={onHideAll}
              hitSlop={6}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              <Text style={[styles.actionText, allHidden && styles.actionTextOff]}>Hide all</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      <Pressable
        testID="ar-filter"
        role="button"
        aria-expanded={open}
        accessibilityState={{ expanded: open }}
        aria-label={summary ? `Layers, ${summary}` : "Layers"}
        accessibilityHint="Choose which kinds of labels the AR view draws"
        onPress={onToggleOpen}
        hitSlop={8}
        style={[styles.button, open && styles.buttonOpen, hiddenCount > 0 && !open && styles.buttonFiltered]}
      >
        <MaterialCommunityIcons
          name={hiddenCount > 0 ? "layers-off-outline" : "layers-outline"}
          size={24}
          color={open ? color.bg : hiddenCount > 0 ? color.status.warn : color.text}
        />
        {hiddenCount > 0 ? (
          <View testID="ar-filter-badge" style={styles.badge} pointerEvents="none">
            <Text style={styles.badgeText}>{hiddenCount}</Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", right: space.lg, alignItems: "flex-end", gap: space.sm },
  button: {
    width: AR_FILTER_BUTTON,
    height: AR_FILTER_BUTTON,
    borderRadius: AR_FILTER_BUTTON / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: alpha(color.bg, 0.85),
    borderColor: alpha(color.text, 0.4),
    borderWidth: StyleSheet.hairlineWidth,
  },
  buttonOpen: { backgroundColor: color.text, borderColor: color.text },
  buttonFiltered: { borderColor: alpha(color.status.warn, 0.8), borderWidth: 1 },
  badge: {
    position: "absolute",
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.status.warn,
  },
  badgeText: { color: color.bg, fontSize: 11, fontWeight: "800", fontVariant: ["tabular-nums"] },
  panel: {
    gap: 6,
    padding: space.sm,
    borderRadius: 12,
    backgroundColor: "rgba(11, 22, 34, 0.9)",
    alignItems: "stretch",
    minWidth: 156,
  },
  // 40 px tall: a comfortable touch target, as in the List filter and the cockpit's Layers panel.
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: 20,
    borderWidth: 1,
  },
  chipOff: { backgroundColor: "transparent", borderColor: color.handle },
  pressed: { opacity: 0.7 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { color: color.text, fontSize: 14, fontWeight: "600" },
  chipTextOff: { color: color.textLabel },
  actions: { flexDirection: "row", justifyContent: "space-between", gap: space.sm, paddingTop: space.xxs },
  action: { minHeight: 32, justifyContent: "center", paddingHorizontal: space.xs },
  actionText: { color: color.entity.air, fontSize: font.label + 1, fontWeight: "700" },
  actionTextOff: { color: color.textMuted },
});
