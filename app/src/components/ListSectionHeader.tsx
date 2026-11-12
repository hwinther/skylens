/**
 * Collapsible List section heading: entity dot + "Title (count)" + optional breakdown + a chevron.
 * The whole row is a button with `aria-expanded`; the count stays visible while collapsed.
 */

import { color } from "@/theme";
import { Pressable, StyleSheet, Text, View } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";

export interface ListSectionHeaderProps {
  /** Pressable testID (`list-section-<section>`). */
  testID: string;
  /** testID of the "Title (count)" text, which tests read (e.g. `list-count`). */
  countTestID: string;
  title: string;
  count: number;
  dotColor: string;
  expanded: boolean;
  onToggle: () => void;
  /** Right-aligned secondary text (the Traffic "3 air · 2 sea" split). */
  breakdown?: string;
}

export function ListSectionHeader({
  testID,
  countTestID,
  title,
  count,
  dotColor,
  expanded,
  onToggle,
  breakdown,
}: ListSectionHeaderProps) {
  return (
    <Pressable
      testID={testID}
      onPress={onToggle}
      role="button"
      aria-expanded={expanded}
      aria-label={`${title}, ${count}, ${expanded ? "collapse" : "expand"}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      <Text testID={countTestID} style={styles.heading} numberOfLines={1}>
        {title} ({count})
      </Text>
      {breakdown ? <Text style={styles.breakdown}>{breakdown}</Text> : null}
      <MaterialCommunityIcons
        name={expanded ? "chevron-up" : "chevron-down"}
        size={22}
        color={color.textDim}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 48,
    paddingLeft: 16,
    paddingRight: 12,
  },
  pressed: { backgroundColor: color.surface },
  dot: { width: 8, height: 8, borderRadius: 4 },
  heading: { color: color.text, fontSize: 18, fontWeight: "700", flex: 1 },
  breakdown: { color: color.textDim, fontSize: 13, fontWeight: "600" },
});
