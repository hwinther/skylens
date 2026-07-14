/**
 * Shared bottom-sheet chrome for the four detail sheets (aircraft / vessel / satellite / planet).
 * They all repeat the same Modal + backdrop + drag handle + Close affordance, differing only by the
 * family accent on the Close text (and each sheet's own body). This owns the chrome; each sheet keeps
 * only its content. Backdrop + handle come from tokens (color.scrim / color.handle).
 */
import { color } from "@/theme";
import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  /** Family accent for the Close affordance (color.entity.air | sea | orbit | sky). */
  accent: string;
  /** Cap sheet height for the scrolling sheets; omit for the short aircraft sheet. */
  maxHeightPct?: number;
  children: ReactNode;
}

export function Sheet({ visible, onClose, accent, maxHeightPct, children }: SheetProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, maxHeightPct ? { maxHeight: `${maxHeightPct}%` } : null]}>
        <View style={styles.handle} />
        {children}
        <Pressable style={styles.close} onPress={onClose} hitSlop={8}>
          <Text style={[styles.closeText, { color: accent }]}>Close</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: color.scrim },
  sheet: {
    backgroundColor: color.bg,
    padding: 20,
    paddingBottom: 36,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  handle: {
    alignSelf: "center",
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.handle,
    marginBottom: 12,
  },
  close: { marginTop: 16, alignItems: "center" },
  closeText: { fontSize: 16 },
});
