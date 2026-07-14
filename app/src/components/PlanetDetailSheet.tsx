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

import { alpha, color } from "@/theme";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Sheet } from "./Sheet";
import {
  Body,
  bodyForKey,
  computeJupiterMoons,
  moonEmeInfo,
  nextPlanetEvents,
  type JupiterMoonsView,
  type PlanetObserver,
  type PlanetView,
} from "@/ar";
import { compass8 } from "./webmap/relative";

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

  // Galilean-moon finder configuration for Jupiter only — pure geometry (no observer, no visibility),
  // so it shows even when Jupiter is below the horizon. Same once-per-open captured instant as `eme`,
  // off the render hot path. Null for any body that isn't Jupiter.
  const jupiterMoons = useMemo(() => {
    if (body == null || bodyForKey(body) !== Body.Jupiter) return null;
    return computeJupiterMoons(new Date(openedAt));
  }, [body, openedAt]);

  const name = view?.name?.trim() || body || "";

  return (
    <Sheet visible={body != null} onClose={onClose} accent={color.entity.sky} maxHeightPct={82}>
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

        {jupiterMoons ? <GalileanMoons view={jupiterMoons} /> : null}

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <Text style={styles.attribution}>Ephemeris: astronomy-engine (on-device)</Text>
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

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The classic Galilean-moon finder strip: Jupiter centred, Io/Europa/Ganymede/Callisto as labelled
 * dots either side, scaled to the widest moon's plane-of-sky offset. Convention: celestial EAST is on
 * the LEFT (the naked-eye / binocular view), so a moon east of Jupiter (+x) is drawn to the left; the
 * edges are labelled "E" / "W". Labels alternate above (Europa, Callisto) / below (Io, Ganymede) so
 * they don't collide when two moons crowd together. Pure Views — no SVG.
 */
function GalileanMoons({ view }: { view: JupiterMoonsView }) {
  const maxAbs = view.maxAbsXArcsec || 1; // guard the (impossible) all-zero case
  const offsets = view.moons
    .map((m) => `${m.name} ${(Math.abs(m.xArcsec) / 60).toFixed(1)}′ ${m.xArcsec >= 0 ? "E" : "W"}`)
    .join("  ·  ");
  return (
    <View testID="jupiter-moons" style={styles.eventSection}>
      <Text style={styles.eventHeading}>Galilean moons</Text>
      <View style={styles.moonStrip}>
        <View style={styles.moonAxis} />
        <Text style={[styles.moonEdge, styles.moonEdgeLeft]}>E</Text>
        <Text style={[styles.moonEdge, styles.moonEdgeRight]}>W</Text>
        <View style={styles.jupiterRing}>
          <View style={styles.jupiterCore} />
        </View>
        {view.moons.map((m, i) => {
          // +x = celestial east; east renders on the LEFT, so a positive offset maps to a smaller left%.
          const leftPct = 50 - clamp(m.xArcsec / maxAbs, -1, 1) * 45;
          const above = i % 2 === 1; // Europa (1) & Callisto (3) above; Io (0) & Ganymede (2) below.
          return (
            <View key={m.key} style={[styles.moonCol, { left: `${leftPct}%` }]}>
              <Text style={[styles.moonName, above ? styles.moonNameAbove : styles.moonNameBelow]}>
                {m.name}
              </Text>
              <View style={styles.moonDot} />
            </View>
          );
        })}
      </View>
      <Text style={styles.moonOffsets}>{offsets}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  title: { color: "#FBEFD0", fontSize: 20, fontWeight: "700", flexShrink: 1 },
  chip: {
    backgroundColor: alpha(color.entity.sky, 0.16),
    borderColor: alpha(color.entity.sky, 0.8),
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
    marginLeft: "auto",
  },
  chipText: { color: color.entity.sky, fontSize: 11, fontWeight: "700" },
  liveRows: { gap: 2, marginBottom: 8 },
  belowMask: { color: color.textLabel, fontSize: 13, fontStyle: "italic", marginBottom: 8 },
  eventSection: {
    borderTopColor: color.surface2,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    marginBottom: 4,
    gap: 2,
  },
  eventHeading: { color: color.entity.sky, fontSize: 12, fontWeight: "700", textTransform: "uppercase" },
  eventValue: { color: "#FBEFD0", fontSize: 14, fontWeight: "600" },
  eventMuted: { color: color.textLabel, fontSize: 13, fontStyle: "italic" },
  eventNote: { color: color.textDim, fontSize: 12, fontStyle: "italic", marginTop: 2 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  rowLabel: { color: color.textLabel, fontSize: 14 },
  rowValue: { color: color.text, fontSize: 14, fontWeight: "500" },
  scroll: { flexGrow: 0 },
  scrollContent: { paddingTop: 4 },
  attribution: { color: color.textMuted, fontSize: 11, marginTop: 12 },
  // Galilean-moon finder strip.
  moonStrip: { position: "relative", height: 72, marginTop: 8, marginBottom: 2 },
  moonAxis: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 36,
    height: StyleSheet.hairlineWidth,
    backgroundColor: alpha(color.entity.sky, 0.18),
  },
  moonEdge: { position: "absolute", top: 30, color: color.textMuted, fontSize: 10, fontWeight: "700" },
  moonEdgeLeft: { left: 2 },
  moonEdgeRight: { right: 2 },
  jupiterRing: {
    position: "absolute",
    left: "50%",
    marginLeft: -11,
    top: 25,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(color.entity.sky, 0.4),
    backgroundColor: alpha(color.entity.sky, 0.06),
    alignItems: "center",
    justifyContent: "center",
  },
  jupiterCore: { width: 12, height: 12, borderRadius: 6, backgroundColor: color.entity.sky },
  moonCol: {
    position: "absolute",
    top: 0,
    height: 72,
    width: 56,
    marginLeft: -28,
    alignItems: "center",
    justifyContent: "center",
  },
  moonDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: color.entity.sky },
  moonName: {
    position: "absolute",
    left: 0,
    right: 0,
    textAlign: "center",
    color: color.textDim,
    fontSize: 10,
  },
  moonNameAbove: { bottom: 44 },
  moonNameBelow: { top: 44 },
  moonOffsets: {
    color: color.textDim,
    fontSize: 12,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
    marginTop: 2,
  },
});
