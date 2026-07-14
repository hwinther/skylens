/**
 * Airport detail bottom sheet. Opens on a tap of an airport marker (geographic map) or a radar diamond.
 * Presentation-only — mirrors VesselDetailSheet's chrome but does NO network: the airports layer already
 * fetched everything (runways + frequencies join) into the `airport` DTO the mounting screen passes in.
 *
 * Its own steel-blue family (matching the airport markers/diamonds) sets it apart from the aircraft-blue,
 * vessel-teal and satellite-violet sheets. `airport` may be undefined if the selection has gone stale;
 * the sheet then just shows the ident it was opened with.
 */

import { alpha, color } from "@/theme";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { AirportDto, AirportFrequencyDto, RunwayDto } from "@/api/types";
import { AIRPORT_COLOR, airportTypeLabel } from "./webmap/airportStyle";

export interface AirportDetailSheetProps {
  /** Selected ident, or null when nothing is selected (keeps the Modal mounted so it can animate). */
  ident: string | null;
  /** The airport DTO already in hand from the airports layer; undefined once the selection goes stale. */
  airport?: AirportDto;
  onClose: () => void;
}

/** "03/21" from a runway's low/high-end idents, whichever are present. */
function runwayName(r: RunwayDto): string {
  const ends = [r.leIdent?.trim(), r.heIdent?.trim()].filter(Boolean);
  return ends.length > 0 ? ends.join("/") : "Runway";
}

/** "6677 ft · ASP" — length + surface, whichever are present. */
function runwayDetail(r: RunwayDto): string | null {
  const parts: string[] = [];
  if (r.lengthFt != null && r.lengthFt > 0) parts.push(`${r.lengthFt.toLocaleString()} ft`);
  if (r.surface?.trim()) parts.push(r.surface.trim());
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "TWR · Kristiansand Tower" — frequency type + description, whichever are present. */
function frequencyLabel(f: AirportFrequencyDto): string {
  const parts = [f.type?.trim() || null, f.description?.trim() || null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Frequency";
}

export function AirportDetailSheet({ ident, airport, onClose }: AirportDetailSheetProps) {
  const name = airport?.name?.trim() || ident || "";
  const runways = airport?.runways ?? [];
  const frequencies = airport?.frequencies ?? [];
  const elevation =
    airport?.elevationFt != null ? `${airport.elevationFt.toLocaleString()} ft` : null;

  return (
    <Modal visible={ident != null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />

        <View style={styles.header}>
          <Text testID="airport-detail-title" style={styles.title} numberOfLines={1}>
            {name}
          </Text>
          {airport?.iata?.trim() ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>{airport.iata.trim()}</Text>
            </View>
          ) : null}
          {ident != null ? <Text style={styles.ident}>{ident}</Text> : null}
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <View style={styles.section}>
            {airport ? <Row label="Type" value={airportTypeLabel(airport.type)} /> : null}
            {airport?.municipality?.trim() ? (
              <Row label="Municipality" value={airport.municipality.trim()} />
            ) : null}
            {elevation ? <Row label="Elevation" value={elevation} /> : null}
          </View>

          {runways.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Runways</Text>
              {runways.map((r, i) => (
                <View key={`rwy-${i}`} testID={`airport-runway-${i}`} style={styles.row}>
                  <Text style={styles.rowLabel}>{runwayName(r)}</Text>
                  <Text style={styles.rowValue}>{runwayDetail(r) ?? "—"}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {frequencies.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Frequencies</Text>
              {frequencies.map((f, i) => (
                <View key={`freq-${i}`} testID={`airport-freq-${i}`} style={styles.row}>
                  <Text style={styles.rowLabel}>{frequencyLabel(f)}</Text>
                  <Text style={styles.rowValue}>
                    {f.mhz != null ? `${f.mhz.toFixed(3)} MHz` : "—"}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          {airport && runways.length === 0 && frequencies.length === 0 ? (
            <Text testID="airport-detail-empty" style={styles.empty}>
              No runway or frequency data
            </Text>
          ) : null}
        </ScrollView>

        <Text style={styles.attribution}>Airports: OurAirports (public domain)</Text>
        <Pressable style={styles.close} onPress={onClose}>
          <Text style={styles.closeText}>Close</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value ?? "—"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    backgroundColor: color.bg,
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
  title: { color: "#E6F0F8", fontSize: 20, fontWeight: "700", flexShrink: 1 },
  chip: {
    backgroundColor: alpha(color.airport, 0.16),
    borderColor: alpha(color.airport, 0.8),
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  chipText: { color: AIRPORT_COLOR, fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  ident: { color: color.textLabel, fontSize: 13, fontWeight: "600", marginLeft: "auto" },
  scroll: { flexGrow: 0 },
  scrollContent: { paddingTop: 2, gap: 12 },
  section: { gap: 2 },
  sectionTitle: {
    color: AIRPORT_COLOR,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    marginBottom: 2,
  },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  rowLabel: { color: color.textLabel, fontSize: 14 },
  rowValue: { color: color.text, fontSize: 14, fontWeight: "500" },
  empty: { color: color.textLabel, fontSize: 14, paddingVertical: 8 },
  attribution: { color: color.textMuted, fontSize: 11, marginTop: 12 },
  close: { marginTop: 16, alignItems: "center" },
  closeText: { color: AIRPORT_COLOR, fontSize: 16 },
});
