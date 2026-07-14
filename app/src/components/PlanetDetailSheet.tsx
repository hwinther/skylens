/**
 * Planet detail bottom sheet. Opens on a tap of a planet label (AR overlay) or a "Sky"-list row.
 *
 * Mirrors SatelliteDetailSheet's chrome and close behaviour but needs NO network: a body is a pure
 * function of the observer + instant, so the "tonight" rise / set / culmination are computed locally
 * (nextPlanetEvents) once per open. Its own warm GOLD family sets it apart from the aircraft (blue),
 * vessel (teal) and satellite (violet) sheets. The live rows (elevation / azimuth / distance) are
 * driven by the 30 s `view` the mounting screen passes — the same entry the overlay renders — and are
 * hidden once the body dips below the horizon (no `view`), while the static facts keep showing.
 */

import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  Body,
  bodyForKey,
  moonEmeInfo,
  nextPlanetEvents,
  type PlanetObserver,
  type PlanetView,
} from "@/ar";
import { compass8 } from "./webmap/relative";

// Gold family — matches PlanetLabel; a warm accent distinct from aircraft blue / vessel teal / sat violet.
const PLANET_GOLD = "#FFCF5C";

export interface PlanetDetailSheetProps {
  /** Selected body key, or null when nothing is selected (keeps the Modal mounted so it can animate). */
  body: string | null;
  /** Live 30 s view from the hook's byBody map; undefined once the body drops below the horizon. */
  view?: PlanetView;
  /** Observer position for the "tonight" rise/set/culmination prediction; omit (or null) to hide it. */
  observer?: PlanetObserver | null;
  onClose: () => void;
}

/** Local wall-clock time for an event instant, e.g. "18:42" (display only). */
function eventClock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Short local calendar date for an event days away, e.g. "Jul 24" (display only). */
function eventDate(d: Date): string {
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function PlanetDetailSheet({ body, view, observer, onClose }: PlanetDetailSheetProps) {
  // Capture "now" once per open so the predicted times are fixed while the sheet is up.
  const [openedAt, setOpenedAt] = useState<number>(() => Date.now());
  useEffect(() => {
    if (body != null) setOpenedAt(Date.now());
  }, [body]);

  // Predict tonight's events once per open (keyed on body + observer + the captured instant), NOT per
  // render. Pure + local — no fetch. Null when the body key is unknown or no observer is available.
  const events = useMemo(() => {
    if (body == null || !observer) return null;
    const b = bodyForKey(body);
    if (!b) return null;
    return nextPlanetEvents(b, observer, new Date(openedAt));
  }, [body, observer, openedAt]);

  // EME (moonbounce) facts for the Moon only — geocentric, so no observer needed. Same once-per-open
  // captured instant as `events`, off the render hot path. Null for any body that isn't the Moon.
  const eme = useMemo(() => {
    if (body == null || bodyForKey(body) !== Body.Moon) return null;
    return moonEmeInfo(new Date(openedAt));
  }, [body, openedAt]);

  const name = view?.name?.trim() || body || "";

  return (
    <Modal visible={body != null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />

        <View style={styles.header}>
          <Text testID="planet-detail-title" style={styles.title} numberOfLines={1}>
            {name}
          </Text>
          {view?.constellation ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>in {view.constellation}</Text>
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
            {view.magnitude != null ? (
              <LiveRow label="Magnitude" value={view.magnitude.toFixed(1)} />
            ) : null}
            {view.phasePercent != null ? (
              <LiveRow label="Illuminated" value={`${Math.round(view.phasePercent)}%`} />
            ) : null}
            {view.distanceAu != null ? (
              <LiveRow label="Distance" value={`${view.distanceAu.toPrecision(3)} AU`} />
            ) : null}
          </View>
        ) : (
          <Text style={styles.belowMask}>Below the horizon — live sky data hidden.</Text>
        )}

        <View testID="planet-tonight" style={styles.eventSection}>
          <Text style={styles.eventHeading}>Tonight</Text>
          {observer == null ? (
            <Text style={styles.eventMuted}>Location needed for rise/set times</Text>
          ) : events == null ? (
            <Text style={styles.eventMuted}>Unavailable</Text>
          ) : (
            <>
              <EventRow label="Rises" value={events.rise ? eventClock(events.rise) : "—"} />
              <EventRow
                label="Culminates"
                value={
                  events.culmination
                    ? `${eventClock(events.culmination)}${
                        events.culminationAltitude != null
                          ? ` · ${Math.round(events.culminationAltitude)}°`
                          : ""
                      }`
                    : "—"
                }
              />
              <EventRow label="Sets" value={events.set ? eventClock(events.set) : "—"} />
              {events.rise == null && events.set == null ? (
                <Text style={styles.eventNote}>Circumpolar — no rise or set in the next day.</Text>
              ) : null}
            </>
          )}
        </View>

        {eme ? (
          <View testID="moon-eme" style={styles.eventSection}>
            <Text style={styles.eventHeading}>Moonbounce (EME)</Text>
            <LiveRow
              label="Antenna el / az"
              value={
                view
                  ? `${Math.round(view.elevationDeg)}° / ${Math.round(view.azimuthDeg)}° ${compass8(view.azimuthDeg)}`
                  : "Below horizon"
              }
            />
            <LiveRow label="Distance" value={`${Math.round(eme.distanceKm).toLocaleString()} km`} />
            <LiveRow label="Echo delay" value={`${eme.echoDelaySeconds.toFixed(2)} s`} />
            <LiveRow
              label="Path-loss penalty"
              value={`+${eme.pathLossPenaltyDb.toFixed(1)} dB vs perigee`}
            />
            <LiveRow
              label="Libration"
              value={`${eme.librationLatDeg.toFixed(1)}°, ${eme.librationLonDeg.toFixed(1)}°`}
            />
            <EventRow
              label="Next perigee"
              value={`${eventDate(eme.nextPerigee.date)} · ${Math.round(eme.nextPerigee.km)} km`}
            />
            <EventRow
              label="Next apogee"
              value={`${eventDate(eme.nextApogee.date)} · ${Math.round(eme.nextApogee.km)} km`}
            />
          </View>
        ) : null}

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <Text style={styles.attribution}>Ephemeris: astronomy-engine (on-device)</Text>
        </ScrollView>

        <Pressable style={styles.close} onPress={onClose}>
          <Text style={styles.closeText}>Close</Text>
        </Pressable>
      </View>
    </Modal>
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
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    backgroundColor: "#0B1622",
    padding: 20,
    paddingBottom: 36,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: "82%",
  },
  handle: {
    alignSelf: "center",
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#33506b",
    marginBottom: 12,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  title: { color: "#FBEFD0", fontSize: 20, fontWeight: "700", flexShrink: 1 },
  chip: {
    backgroundColor: "rgba(255, 207, 92, 0.16)",
    borderColor: "rgba(255, 207, 92, 0.8)",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
    marginLeft: "auto",
  },
  chipText: { color: PLANET_GOLD, fontSize: 11, fontWeight: "700" },
  liveRows: { gap: 2, marginBottom: 8 },
  belowMask: { color: "#7fa6c4", fontSize: 13, fontStyle: "italic", marginBottom: 8 },
  eventSection: {
    borderTopColor: "#16283a",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    marginBottom: 4,
    gap: 2,
  },
  eventHeading: { color: PLANET_GOLD, fontSize: 12, fontWeight: "700", textTransform: "uppercase" },
  eventValue: { color: "#FBEFD0", fontSize: 14, fontWeight: "600" },
  eventMuted: { color: "#7fa6c4", fontSize: 13, fontStyle: "italic" },
  eventNote: { color: "#9FC7E0", fontSize: 12, fontStyle: "italic", marginTop: 2 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  rowLabel: { color: "#7fa6c4", fontSize: 14 },
  rowValue: { color: "#EAF6FF", fontSize: 14, fontWeight: "500" },
  scroll: { flexGrow: 0 },
  scrollContent: { paddingTop: 4 },
  attribution: { color: "#5c7a94", fontSize: 11, marginTop: 12 },
  close: { marginTop: 16, alignItems: "center" },
  closeText: { color: PLANET_GOLD, fontSize: 16 },
});
