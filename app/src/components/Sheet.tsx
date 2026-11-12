/**
 * Shared chrome for the six detail sheets (aircraft / vessel / satellite / planet / radio / airport):
 * a NON-MODAL card. There is no scrim and no Modal portal, so the scene behind (AR view, map, list)
 * stays bright and interactive while a card is open, and tapping another object just swaps the
 * card's content. The card is an ordinary absolutely positioned view, so each screen mounts it as the
 * last child of the area it should cover (which sits above the tab bar).
 *
 * Layout (see sheetLayout.ts, the pure policy):
 *  - narrow windows: a compact card at the bottom. Collapsed it shows `header` + a one-line `summary`
 *    (+ `actions`); tap the card, its handle or the chevron to expand to the full `children`, capped
 *    at `maxHeightPct` and scrolling inside.
 *  - wide windows (SIDE_PANEL_BREAKPOINT+): a SIDE_PANEL_WIDTH panel docked right, always expanded.
 *
 * Dismiss: the close button, Escape on web, the hardware back button on Android. Both listeners are
 * only registered while the card is open AND its screen is focused (tabs stay mounted in the
 * background). No focus trap and no focus stealing: it is a labelled region, not a dialog.
 */
import { alpha, color } from "@/theme";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { sheetLayout, sheetRightInset } from "./sheetLayout";

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  /** Family accent for the card's controls and edge (color.entity.air | sea | orbit | sky | radio). */
  accent: string;
  /** Accessible name of the card region, e.g. "Aircraft details". */
  label: string;
  /** Always shown: the title row (keeps each sheet's title testID). */
  header: ReactNode;
  /** Shown only in the collapsed compact card: a one-line summary of the most useful live values. */
  summary?: ReactNode;
  /** Always shown under the header: quick actions (Show on map, Cockpit view, ground track). */
  actions?: ReactNode;
  /** Cap on the expanded compact card's height (percent of the screen); defaults to 82. */
  maxHeightPct?: number;
  /** Side panel only: distance from the top of the parent, e.g. to clear a status strip. */
  panelTop?: number;
  /** The full content: always shown in the side panel, behind the expand toggle in the compact card. */
  children: ReactNode;
}

/** The collapsed card's one-line summary: the parts that are known, joined by " · ". */
export function SheetSummary({ parts }: { parts: (string | null | undefined | false)[] }) {
  const text = parts.filter(Boolean).join(" · ");
  if (!text) return null;
  return (
    <Text style={styles.summaryText} numberOfLines={1}>
      {text}
    </Text>
  );
}

/** Style for a button in the card's `actions` row: share the row, no stacked top margin. */
export const sheetActionStyle: ViewStyle = { flex: 1, marginTop: 0, paddingVertical: 8 };

/** Right-edge inset an open card claims on this window (the side panel's width, else 0). */
export function useSheetRightInset(open: boolean): number {
  const { width } = useWindowDimensions();
  return sheetRightInset(width, open);
}

/** Escape (web) and the hardware back button (Android) close the card while its screen is focused. */
function useDismissKeys(visible: boolean, onClose: () => void) {
  useFocusEffect(
    useCallback(() => {
      if (!visible) return undefined;
      if (Platform.OS === "web") {
        if (typeof document === "undefined") return undefined;
        const onKey = (e: KeyboardEvent) => {
          if (e.key === "Escape" && !e.defaultPrevented) onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }
      if (Platform.OS === "android") {
        const sub = BackHandler.addEventListener("hardwareBackPress", () => {
          onClose();
          return true;
        });
        return () => sub.remove();
      }
      return undefined;
    }, [visible, onClose]),
  );
}

// Web only: frost the scene behind the translucent surface. Native stays plain translucency (no blur
// dependency). react-native-web understands backdropFilter; RN's ViewStyle type doesn't list it.
const webBlur: ViewStyle | null =
  Platform.OS === "web" ? ({ backdropFilter: "blur(12px)" } as unknown as ViewStyle) : null;

export function Sheet({
  visible,
  onClose,
  accent,
  label,
  header,
  summary,
  actions,
  maxHeightPct,
  panelTop,
  children,
}: SheetProps) {
  const { width } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  // Every fresh open starts collapsed; swapping the selected object keeps the user's choice.
  useEffect(() => {
    if (!visible) setExpanded(false);
  }, [visible]);
  useDismissKeys(visible, onClose);

  if (!visible) return null;

  const layout = sheetLayout({ windowWidth: width, expanded, maxHeightPct });
  const panel = layout.mode === "panel";
  const toggle = () => setExpanded((e) => !e);

  const headInner = (
    <>
      {layout.showToggle ? <View style={styles.handle} /> : null}
      <View style={styles.headRow}>
        <View style={styles.headContent}>{header}</View>
        {layout.showToggle ? (
          <Pressable
            testID="detail-card-toggle"
            accessibilityRole="button"
            accessibilityLabel={expanded ? "Collapse details" : "Expand details"}
            aria-expanded={expanded}
            onPress={toggle}
            hitSlop={8}
            style={styles.iconButton}
          >
            <Ionicons name={expanded ? "chevron-down" : "chevron-up"} size={20} color={accent} />
          </Pressable>
        ) : null}
        <Pressable
          testID="detail-card-close"
          accessibilityRole="button"
          accessibilityLabel="Close details"
          onPress={onClose}
          hitSlop={8}
          style={styles.iconButton}
        >
          <Ionicons name="close" size={20} color={accent} />
        </Pressable>
      </View>
      {layout.showSummary && summary ? (
        <View testID="detail-card-summary" style={styles.summary}>
          {summary}
        </View>
      ) : null}
    </>
  );

  return (
    <View
      testID="detail-card"
      role="region"
      accessibilityLabel={label}
      style={[
        styles.card,
        webBlur,
        panel
          ? [styles.panel, { width: layout.width, top: panelTop ?? 0, borderLeftColor: alpha(accent, 0.5) }]
          : [
              styles.compact,
              { left: layout.sideInset, right: layout.sideInset, borderTopColor: alpha(accent, 0.5) },
              layout.maxHeightPct != null ? { maxHeight: `${layout.maxHeightPct}%` } : null,
            ],
      ]}
    >
      {layout.showToggle ? (
        // The whole head (handle, header, summary) is a tap target for expand/collapse. It stays out
        // of the tab order and the accessibility tree: the chevron is the labelled button for that.
        <Pressable onPress={toggle} accessible={false} focusable={false} style={styles.head}>
          {headInner}
        </Pressable>
      ) : (
        <View style={styles.head}>{headInner}</View>
      )}
      {actions ? <View style={styles.actions}>{actions}</View> : null}
      {layout.showBody ? (
        <ScrollView
          testID="detail-card-body"
          style={[styles.body, panel && styles.bodyPanel]}
          contentContainerStyle={styles.bodyContent}
        >
          {children}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    // Above the scene, incl. Leaflet's panes/controls (z-index 400-1000); below the app-level
    // ApiIssueBanner / SignInPrompt (2000), which are alerts and should stay on top.
    zIndex: 1100,
    elevation: 10,
    backgroundColor: color.sheetSurface,
    borderColor: color.surface2,
  },
  compact: {
    bottom: 8,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopWidth: 2,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 12,
  },
  panel: {
    right: 0,
    bottom: 0,
    borderLeftWidth: 2,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
  },
  head: {},
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.handle,
    marginBottom: 6,
  },
  headRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  headContent: { flex: 1, minWidth: 0 },
  iconButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
  },
  summary: { marginTop: 2 },
  summaryText: { color: color.textDim, fontSize: 14, fontWeight: "500" },
  actions: { flexDirection: "row", gap: 8, marginTop: 8 },
  body: { flexGrow: 0, flexShrink: 1, marginTop: 8 },
  bodyPanel: { flexGrow: 1 },
  bodyContent: { paddingBottom: 4 },
});
