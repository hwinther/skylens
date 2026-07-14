/**
 * A quiet, on-brand empty / loading placeholder for surfaces that render nothing when there's no
 * data (List, Radar) — muted secondary guidance, not an alert. Two shapes:
 *  - full (default): a padded, centred block with icon + title + optional message/action (List).
 *  - compact: absolute-fill, box-none, icon + title only — sits centred over the radar rings without
 *    ever eating a blip tap.
 * Static styling only; safe over the rAF overlay.
 */

import { alpha, color } from "@/theme";
import type { ComponentProps } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";

export interface EmptyStateProps {
  icon?: ComponentProps<typeof MaterialCommunityIcons>["name"];
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Compact centred caption (radar overlay) vs full padded block (list). */
  compact?: boolean;
}

export function EmptyState({
  icon = "radar",
  title,
  message,
  actionLabel,
  onAction,
  compact,
}: EmptyStateProps) {
  return (
    <View style={[styles.wrap, compact && styles.compact]} pointerEvents="box-none">
      <MaterialCommunityIcons
        name={icon}
        size={compact ? 22 : 30}
        color={alpha(color.entity.air, 0.55)}
      />
      <Text style={styles.title}>{title}</Text>
      {!compact && message ? <Text style={styles.message}>{message}</Text> : null}
      {actionLabel && onAction ? (
        <Pressable style={styles.action} onPress={onAction} hitSlop={8}>
          <Text style={styles.actionText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center", paddingHorizontal: 32, paddingVertical: 64, gap: 12 },
  compact: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, paddingVertical: 0, gap: 6 },
  title: { color: "#DCEBF7", fontSize: 15, fontWeight: "600", textAlign: "center" },
  message: { color: color.textLabel, fontSize: 13, lineHeight: 19, textAlign: "center", maxWidth: 320 },
  action: {
    marginTop: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(color.entity.air, 0.4),
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  actionText: { color: color.entity.air, fontSize: 13, fontWeight: "600" },
});
