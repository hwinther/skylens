/**
 * Vessel detail bottom sheet. Opens on a tap of a ship/AtoN row in the List tab or a vessel marker on
 * the Map. Mirrors SatelliteDetailSheet: a cancellable fetch on mmsi change (GET /api/vessels/{mmsi}
 * for the BarentsWatch-enriched static/voyage metadata) plus the same sheet chrome and close behaviour,
 * and it self-provisions its own ApiClient the same way.
 *
 * Its own teal family (matching the vessel labels/markers) sets it apart from the aircraft-blue and
 * satellite-violet sheets. The live rows — position, SOG/COG/heading, nav-status — are driven by the
 * `vessel` DTO the mounting screen passes straight from the 5 s list, so they stay as fresh as the map;
 * the fetched metadata supplies the slow-changing identity/voyage fields the slim DTO doesn't carry.
 * `vessel` may be undefined if the target has aged out of the list; the fetched static data still shows.
 */

import { alpha, color } from "@/theme";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl } from "@/api/config";
import type { VesselDetail, VesselDto } from "@/api/types";
import { aidTypeLabel, formatDimensions, navStatusText } from "./vesselFormat";

// Teal family — matches VesselLabel / iconForVessel; a maritime accent distinct from aircraft blue
// and satellite violet.

export interface VesselDetailSheetProps {
  /** Selected MMSI, or null when nothing is selected (keeps the Modal mounted so it can animate). */
  mmsi: string | null;
  /** Live DTO from the 5 s list, for the always-fresh position/SOG/COG rows; undefined once aged out. */
  vessel?: VesselDto;
  onClose: () => void;
}

export function VesselDetailSheet({ mmsi, vessel, onClose }: VesselDetailSheetProps) {
  const client = useMemo(() => new ApiClient({ baseUrl: getApiBaseUrl() }), []);
  const [detail, setDetail] = useState<VesselDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (mmsi == null) return;
    let cancelled = false;
    setLoading(true);
    client
      .vesselDetail(mmsi)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mmsi, client]);

  const metadata = detail?.metadata ?? null;
  // Identity: prefer the live DTO, fall back to the fetched state, then the bare MMSI.
  const name = vessel?.name?.trim() || detail?.state?.name?.trim() || mmsi || "";
  const kind = vessel?.kind ?? detail?.state?.kind ?? "ship";
  const isAton = kind === "aton";
  const flag = vessel?.flag ?? metadata?.flag ?? null;

  const hasPosition = vessel?.lat != null && vessel?.lon != null;
  // AIS sog is in knots; only meaningful while genuinely under way (>0.5 kn), else it's berth noise.
  const moving = vessel?.sog != null && vessel.sog > 0.5;
  const navStatus = navStatusText(vessel?.navStatus);
  const dims = metadata ? formatDimensions(metadata) : null;
  // IMO 0 (or absent) means "not supplied" — hide the row rather than showing a bogus 0.
  const imo = metadata?.imo != null && metadata.imo > 0 ? String(metadata.imo) : null;
  // The merge keeps the local feed's "ais" source; only an away-mode vessel we don't track locally
  // carries "barentswatch". Either way the underlying observations are AIS.
  const fromBarentsWatch = metadata?.source === "barentswatch";
  // Norwegian ship-register enrichment (FiskInfo). Each field is null off-register; length is a double.
  const registerName = metadata?.registerName?.trim() || null;
  const registerOwner = metadata?.registerOwner?.trim() || null;
  const registerType = metadata?.registerType?.trim() || null;
  const registerLength =
    metadata?.registerLengthOverall != null
      ? `${
          Number.isInteger(metadata.registerLengthOverall)
            ? metadata.registerLengthOverall
            : metadata.registerLengthOverall.toFixed(1)
        } m`
      : null;
  const hasRegister =
    registerName != null ||
    registerOwner != null ||
    registerType != null ||
    registerLength != null;
  // Attribution credits the AIS source, BarentsWatch enrichment, and the ship register when any is present.
  const attribution = [
    fromBarentsWatch ? "AIS · Enriched via BarentsWatch (NLOD)" : "AIS",
    hasRegister ? "Ship register: Norwegian Maritime Authority (NOR/NIS)" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Modal visible={mmsi != null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />

        <View style={styles.header}>
          <Text testID="vessel-detail-title" style={styles.title} numberOfLines={1}>
            {name}
          </Text>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{isAton ? "AtoN" : "Ship"}</Text>
          </View>
          {flag ? <Text style={styles.flag}>{flag}</Text> : null}
          {mmsi != null ? <Text style={styles.mmsi}>{mmsi}</Text> : null}
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {loading && <ActivityIndicator color={color.entity.sea} />}
          {error && <Text style={styles.error}>{error}</Text>}

          <View style={styles.section}>
            {hasPosition ? (
              <Row
                label="Position"
                value={`${vessel!.lat!.toFixed(4)}, ${vessel!.lon!.toFixed(4)}`}
              />
            ) : null}

            {isAton ? (
              <>
                <Row label="Aid type" value={aidTypeLabel(vessel?.aidType)} />
                <Row
                  label="Structure"
                  value={vessel?.virtual ? "Virtual aid" : "Physical aid"}
                />
              </>
            ) : (
              <>
                {moving ? <Row label="Speed" value={`${vessel!.sog!.toFixed(1)} kn`} /> : null}
                {vessel?.cog != null ? (
                  <Row label="Course" value={`${Math.round(vessel.cog)}°`} />
                ) : null}
                {vessel?.hdg != null ? (
                  <Row label="Heading" value={`${Math.round(vessel.hdg)}°`} />
                ) : null}
                {navStatus ? <Row label="Nav status" value={navStatus} /> : null}
              </>
            )}
          </View>

          {/* Static / voyage — the slow fields the slim DTO doesn't carry. AtoNs rarely have any. */}
          {metadata ? (
            <View style={styles.section}>
              <Row label="Type" value={metadata.shipTypeText} />
              <Row label="Call sign" value={metadata.callSign} />
              {/* Ship-register enrichment — each row hidden entirely when the field is absent (like IMO). */}
              {registerName ? <Row label="Registered name" value={registerName} /> : null}
              {registerOwner ? <Row label="Owner" value={registerOwner} /> : null}
              {registerType ? <Row label="Register type" value={registerType} /> : null}
              {registerLength ? <Row label="Length" value={registerLength} /> : null}
              {imo ? <Row label="IMO" value={imo} /> : null}
              <Row label="Destination" value={metadata.destination} />
              <Row label="ETA" value={metadata.eta} />
              <Row
                label="Draught"
                value={metadata.draught != null ? `${metadata.draught.toFixed(1)} m` : null}
              />
              {dims ? <Row label="Dimensions" value={dims} /> : null}
            </View>
          ) : !loading && !error ? (
            <Text testID="vessel-detail-empty" style={styles.empty}>
              No additional data
            </Text>
          ) : null}
        </ScrollView>

        <Text style={styles.attribution}>{attribution}</Text>
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
  title: { color: "#CFF6EE", fontSize: 20, fontWeight: "700", flexShrink: 1 },
  chip: {
    backgroundColor: alpha(color.entity.sea, 0.16),
    borderColor: alpha(color.entity.sea, 0.8),
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  chipText: { color: color.entity.sea, fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  flag: { color: "#8FD3C6", fontSize: 12, fontWeight: "700", textTransform: "uppercase" },
  mmsi: { color: color.textLabel, fontSize: 13, fontWeight: "600", marginLeft: "auto" },
  scroll: { flexGrow: 0 },
  scrollContent: { paddingTop: 2, gap: 12 },
  section: { gap: 2 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  rowLabel: { color: color.textLabel, fontSize: 14 },
  rowValue: { color: color.text, fontSize: 14, fontWeight: "500" },
  error: { color: color.status.error, marginVertical: 8 },
  empty: { color: color.textLabel, fontSize: 14, paddingVertical: 8 },
  attribution: { color: color.textMuted, fontSize: 11, marginTop: 12 },
  close: { marginTop: 16, alignItems: "center" },
  closeText: { color: color.entity.sea, fontSize: 16 },
});
