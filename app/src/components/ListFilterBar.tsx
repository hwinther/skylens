/**
 * List tab filter bar: one toggle chip per kind (Air, Sea, Satellites, Sky, Radio, Events) with its
 * row count, in the kind's entity colour. A shown kind is a filled chip; a hidden one goes hollow and
 * muted. One row that scrolls sideways on a narrow phone instead of wrapping, pinned above the list.
 */

import { alpha, color } from "@/theme";
import { ScrollView, Pressable, StyleSheet, Text, View } from "react-native";
import type { ListChip, ListKind } from "@/state/listFilter";

export interface ListFilterBarProps {
  chips: ListChip[];
  onToggle: (kind: ListKind) => void;
}

export function ListFilterBar({ chips, onToggle }: ListFilterBarProps) {
  return (
    <ScrollView
      testID="list-filter-bar"
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.bar}
      contentContainerStyle={styles.content}
      role="group"
      aria-label="Show in list"
    >
      {chips.map((c) => (
        <Pressable
          key={c.kind}
          testID={`list-filter-${c.kind}`}
          onPress={() => onToggle(c.kind)}
          // A toggle button: pressed = the kind is shown. `aria-pressed` for web (react-native-web
          // ignores accessibilityState); RN has no native mapping for aria-pressed, so native gets
          // the same state as `selected` (TalkBack reads "selected").
          role="button"
          aria-pressed={c.shown}
          accessibilityState={{ selected: c.shown }}
          // No aria-label: the name is the visible label and count ("Air 7"), as axe's
          // label-content-name-mismatch wants (a label "Air, 7" didn't contain the visible text).
          style={({ pressed }) => [
            styles.chip,
            c.shown
              ? { backgroundColor: alpha(c.color, 0.16), borderColor: alpha(c.color, 0.7) }
              : styles.chipOff,
            pressed && styles.chipPressed,
          ]}
        >
          <View
            style={[
              styles.dot,
              c.shown ? { backgroundColor: c.color } : { borderColor: alpha(c.color, 0.6), borderWidth: 1.5 },
            ]}
          />
          <Text style={[styles.label, !c.shown && styles.labelOff]}>{c.label}</Text>
          <Text style={[styles.count, c.shown ? { color: c.color } : styles.labelOff]}>{c.count}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // flexGrow 0: a horizontal ScrollView in a column would otherwise stretch to fill the height.
  bar: {
    flexGrow: 0,
    flexShrink: 0,
    borderBottomColor: color.surface2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  content: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  // 40 px tall: a comfortable touch target.
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
  },
  chipOff: { backgroundColor: "transparent", borderColor: color.handle },
  chipPressed: { opacity: 0.7 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { color: color.text, fontSize: 14, fontWeight: "600" },
  // Dimmed but still readable (textLabel on bg is ~6:1), so a hidden kind stays findable.
  labelOff: { color: color.textLabel },
  count: { fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
});
