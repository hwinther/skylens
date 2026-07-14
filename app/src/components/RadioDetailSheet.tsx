/**
 * Radio-source detail bottom sheet. Opens on a tap of a radio label (AR overlay) or a "Radio"-list row.
 *
 * Mirrors PlanetDetailSheet's chrome and close behaviour and, like it, needs NO network: a fixed source
 * is a pure function of the observer + instant, so the "tonight" transit is computed locally
 * (nextRadioTransit) once per open. Its own signal-lime family (color.entity.radio) sets it apart from
 * the aircraft (blue), vessel (teal), satellite (violet) and planet (gold) sheets. The live rows
 * (elevation / azimuth / RA / Dec) are driven by the 30 s `view` the mounting screen passes and are
 * hidden once the source dips below the horizon, while the static radio facts keep showing.
 *
 * NOTE: the discriminant prop is `sourceKey`, not `key` — React reserves `key` as a JSX reconciliation
 * attribute, so a prop literally named `key` can never reach the component. Everything else mirrors
 * PlanetDetailSheet's `body`-keyed shape.
 */

import { alpha, color } from "@/theme";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Sheet } from "./Sheet";
import {
  HYDROGEN_LINE_MHZ,
  nextRadioTransit,
  type RadioObserver,
  type RadioSource,
  type RadioTargetView,
} from "@/ar";
import { compass8 } from "./webmap/relative";

export interface RadioDetailSheetProps {
  /** Selected source key, or null when nothing is selected (keeps the Modal mounted so it can animate). */
  sourceKey: string | null;
  /** Live 30 s view from the hook's byKey map; undefined once the source drops below the horizon. */
  view?: RadioTargetView;
  /** The static source record (name/kind/blurb/position) for the selected key. */
  source?: RadioSource;
  /** Observer position for the "tonight" transit prediction; omit (or null) to hide it. */
  observer?: RadioObserver | null;
  onClose: () => void;
}

/** Local wall-clock time for an event instant, e.g. "21:29" (display only). */
function eventClock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function RadioDetailSheet({ sourceKey, view, source, observer, onClose }: RadioDetailSheetProps) {
  // Capture "now" once per open so the predicted transit is fixed while the sheet is up.
  const [openedAt, setOpenedAt] = useState<number>(() => Date.now());
  useEffect(() => {
    if (sourceKey != null) setOpenedAt(Date.now());
  }, [sourceKey]);

  // Predict the next transit once per open (keyed on source + observer + the captured instant), NOT per
  // render. Pure + local — no fetch. Null when there's no source, no observer, or it never rises here.
  const transit = useMemo(() => {
    if (sourceKey == null || !source || !observer) return null;
    return nextRadioTransit(source, observer, new Date(openedAt));
  }, [sourceKey, source, observer, openedAt]);

  const name = source?.name?.trim() || view?.name?.trim() || sourceKey || "";
  const kind = source?.kind ?? view?.kind ?? null;

  return (
    <Sheet visible={sourceKey != null} onClose={onClose} accent={color.entity.radio} maxHeightPct={82}>
      <View style={styles.header}>
        <Text testID="radio-detail-title" style={styles.title} numberOfLines={1}>
          {name}
        </Text>
        {kind ? (
          <View style={styles.chip}>
            <Text style={styles.chipText}>{kind}</Text>
          </View>
        ) : null}
      </View>

      {view ? (
        <View style={styles.liveRows}>
          <LiveRow label="Elevation" value={`${Math.round(view.elevationDeg)}°`} />
          <LiveRow
            label="Azimuth"
            value={`${Math.round(view.azimuthDeg)}° ${compass8(view.azimuthDeg)}`}
          />
          <LiveRow label="RA" value={`${view.raHours.toFixed(3)} h`} />
          <LiveRow label="Dec" value={`${view.decDeg.toFixed(2)}°`} />
        </View>
      ) : (
        <Text style={styles.belowMask}>Below the horizon — live sky data hidden.</Text>
      )}

      <View testID="radio-frequency" style={styles.eventSection}>
        <Text style={styles.eventHeading}>Radio</Text>
        <LiveRow label="Rest frequency" value={`${HYDROGEN_LINE_MHZ.toFixed(3)} MHz (H I)`} />
        <Text style={styles.note}>
          Observed line shifts with galactic rotation (LSR) — up to ~±0.7 MHz by direction.
        </Text>
        {source?.blurb ? <Text style={styles.blurb}>{source.blurb}</Text> : null}
      </View>

      <View testID="radio-tonight" style={styles.eventSection}>
        <Text style={styles.eventHeading}>Tonight</Text>
        {observer == null ? (
          <Text style={styles.eventMuted}>Location needed for transit time</Text>
        ) : transit == null ? (
          <Text style={styles.eventMuted}>Never rises here</Text>
        ) : (
          <EventRow
            label="Transit"
            value={`${eventClock(transit.date)} · ${Math.round(transit.altitudeDeg)}°`}
          />
        )}
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.attribution}>Positions: astronomy-engine (on-device)</Text>
      </ScrollView>
    </Sheet>
  );
}

function LiveRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function EventRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.eventValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  title: { color: color.text, fontSize: 20, fontWeight: "700", flexShrink: 1 },
  chip: {
    backgroundColor: alpha(color.entity.radio, 0.16),
    borderColor: alpha(color.entity.radio, 0.8),
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
    marginLeft: "auto",
  },
  chipText: { color: color.entity.radio, fontSize: 11, fontWeight: "700" },
  liveRows: { gap: 2, marginBottom: 8 },
  belowMask: { color: color.textLabel, fontSize: 13, fontStyle: "italic", marginBottom: 8 },
  eventSection: {
    borderTopColor: color.surface2,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    marginBottom: 4,
    gap: 2,
  },
  eventHeading: {
    color: color.entity.radio,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  eventValue: { color: color.text, fontSize: 14, fontWeight: "600" },
  eventMuted: { color: color.textLabel, fontSize: 13, fontStyle: "italic" },
  note: { color: color.textDim, fontSize: 12, fontStyle: "italic", marginTop: 2 },
  blurb: { color: color.textDim, fontSize: 13, marginTop: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  rowLabel: { color: color.textLabel, fontSize: 14 },
  rowValue: { color: color.text, fontSize: 14, fontWeight: "500" },
  scroll: { flexGrow: 0 },
  scrollContent: { paddingTop: 4 },
  attribution: { color: color.textMuted, fontSize: 11, marginTop: 12 },
});
