/**
 * Satellite detail bottom sheet. Opens on a tap of a satellite label (AR overlay) or an Overhead-list
 * row. Mirrors DetailSheet: a cancellable fetch on noradId change (GET /api/satellites/{noradId} for
 * the full SatNOGS transmitter list) plus the same sheet chrome and close behaviour.
 *
 * Its own violet family sets it apart from the aircraft (blue) and vessel (teal) sheets. The live rows
 * are driven by the 1 Hz `view` (the same entry the overlay renders) passed by the mounting screen —
 * so the Doppler-corrected downlink under each active transmitter ticks once a second with no timer of
 * its own. `view` may be undefined if the satellite has dipped below the elevation mask; the fetched
 * static transmitter data keeps showing regardless.
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
import { useRouter } from "expo-router";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl } from "@/api/config";
import type { SatelliteDetail, SatelliteTransmitter } from "@/api/types";
import {
  buildSatrec,
  DEFAULT_ELEVATION_MASK_DEG,
  dopplerCorrectedHz,
  formatCountdown,
  formatFrequencyHz,
  formatPassDuration,
  nextPass,
  passVisibility,
  type Observer,
  type SatelliteView,
} from "@/ar";
import { useSatelliteTrackStore } from "@/state/satelliteTrackStore";
import { compass8 } from "./webmap/relative";

export interface SatelliteDetailSheetProps {
  /** Selected NORAD id, or null when nothing is selected (keeps the Modal mounted so it can animate). */
  noradId: number | null;
  /** Live 1 Hz view from the hook's byNoradId map; undefined once the satellite drops below the mask. */
  view?: SatelliteView;
  /** Observer position for the client-side "Next pass" prediction; omit (or null) to hide that section. */
  observer?: Observer | null;
  /** Elevation mask (deg) the pass prediction uses; defaults to DEFAULT_ELEVATION_MASK_DEG. */
  elevationMaskDeg?: number;
  onClose: () => void;
}

/** Local wall-clock time for a pass instant, e.g. "18:42:10" (display only — not unit-tested). */
function passClock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Active ⇒ the transmitter is currently operational (SatNOGS `alive`). */
function isActive(tx: SatelliteTransmitter): boolean {
  return tx.alive === true;
}

/** Sort: active transmitters first, then those carrying a downlink, then the rest (stable otherwise). */
function sortTransmitters(txs: SatelliteTransmitter[]): SatelliteTransmitter[] {
  return [...txs].sort((a, b) => {
    const activeRank = (isActive(b) ? 1 : 0) - (isActive(a) ? 1 : 0);
    if (activeRank !== 0) return activeRank;
    const downRank = (b.downlinkLowHz != null ? 1 : 0) - (a.downlinkLowHz != null ? 1 : 0);
    return downRank;
  });
}

export function SatelliteDetailSheet({
  noradId,
  view,
  observer,
  elevationMaskDeg,
  onClose,
}: SatelliteDetailSheetProps) {
  const client = useMemo(() => new ApiClient({ baseUrl: getApiBaseUrl() }), []);
  const router = useRouter();
  const setTracked = useSatelliteTrackStore((s) => s.setTracked);
  const [detail, setDetail] = useState<SatelliteDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A 1 Hz wall-clock tick so the "in 2h 14m" countdown stays live while the sheet is open (even when
  // the satellite is below the mask and no `view` arrives to re-render). Cleared on close/unmount.
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (noradId == null) return;
    let cancelled = false;
    setLoading(true);
    client
      .satelliteDetail(noradId)
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
  }, [noradId, client]);

  useEffect(() => {
    if (noradId == null) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [noradId]);

  const maskDeg = elevationMaskDeg ?? DEFAULT_ELEVATION_MASK_DEG;
  // Predict the next pass once per detail load (keyed on the satellite + observer + mask, NOT per
  // render): build a satrec straight from the verbatim OMM and scan it client-side. `new Date()` is
  // captured here so the AOS/LOS times are fixed for this open; only the countdown ticks (via nowMs).
  const passInfo = useMemo(() => {
    if (!detail || !observer) return null;
    const satrec = buildSatrec(detail.satellite.omm);
    if (!satrec) return null;
    const p = nextPass(satrec, observer, new Date(), maskDeg);
    if (!p) return null;
    // Naked-eye visibility of THIS pass, computed once alongside the prediction (same satrec, kept off the
    // render hot path): the sub-window where the satellite is sunlit AND the observer's sky is dark.
    const visibility = passVisibility({ satrec, observer, pass: p, elevationMaskDeg: maskDeg });
    return { pass: p, visibility };
  }, [detail, observer, maskDeg]);
  const pass = passInfo?.pass ?? null;
  const visibility = passInfo?.visibility ?? null;

  // Identity: prefer the live view, fall back to the fetched static satellite, then the bare id.
  const name = view?.name?.trim() || detail?.satellite.name?.trim() || String(noradId ?? "");
  const group = view?.group ?? detail?.satellite.group;
  const transmitters = detail ? sortTransmitters(detail.transmitters) : [];

  return (
    <Modal visible={noradId != null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />

        <View style={styles.header}>
          <Text testID="sat-detail-title" style={styles.title} numberOfLines={1}>
            {name}
          </Text>
          {group ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>{group}</Text>
            </View>
          ) : null}
          {noradId != null ? <Text style={styles.norad}>#{noradId}</Text> : null}
        </View>

        {view ? (
          <View style={styles.liveRows}>
            <LiveRow label="Elevation" value={`${Math.round(view.elevationDeg)}°`} />
            <LiveRow
              label="Azimuth"
              value={`${Math.round(view.azimuthDeg)}° ${compass8(view.azimuthDeg)}`}
            />
            <LiveRow label="Range" value={`${view.rangeKm.toFixed(0)} km`} />
            <LiveRow
              label="Range rate"
              value={`${view.rangeRateKmS < 0 ? "▲" : "▼"} ${Math.abs(view.rangeRateKmS).toFixed(2)} km/s`}
            />
          </View>
        ) : (
          <Text style={styles.belowMask}>Below the elevation mask — live pass data hidden.</Text>
        )}

        <View testID="sat-next-pass" style={styles.passSection}>
          <Text style={styles.passHeading}>Next pass</Text>
          {observer == null ? (
            <Text style={styles.passMuted}>Location needed for passes</Text>
          ) : pass == null ? (
            <Text style={styles.passMuted}>No pass in next 48 h</Text>
          ) : pass.inProgress ? (
            <>
              <Text style={styles.passLine}>
                Overhead now · max {Math.round(pass.maxElevationDeg)}° · ↓ {passClock(pass.losTime)}{" "}
                {compass8(pass.losAzimuthDeg)} · sets {formatCountdown(pass.losTime.getTime() - nowMs)}
              </Text>
              <Text style={styles.passSub}>
                Duration {formatPassDuration(pass.losTime.getTime() - pass.aosTime.getTime())}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.passLine}>
                ↑ {passClock(pass.aosTime)} {compass8(pass.aosAzimuthDeg)} · max{" "}
                {Math.round(pass.maxElevationDeg)}° · ↓ {passClock(pass.losTime)}{" "}
                {compass8(pass.losAzimuthDeg)} · {formatCountdown(pass.aosTime.getTime() - nowMs)}
              </Text>
              <Text style={styles.passSub}>
                Duration {formatPassDuration(pass.losTime.getTime() - pass.aosTime.getTime())}
              </Text>
            </>
          )}
          {visibility?.visible ? (
            <Text testID="sat-visible-badge" style={styles.visibleBadge}>
              {visibility.visibleStart && visibility.visibleEnd
                ? `👁 visible ${passClock(visibility.visibleStart)}–${passClock(visibility.visibleEnd)}`
                : "👁 visible"}
            </Text>
          ) : null}
        </View>

        {noradId != null ? (
          <Pressable
            testID="sat-show-ground-track"
            style={styles.trackButton}
            onPress={() => {
              // Hand the selection to the Map via the ephemeral store, close the sheet, and route to
              // the Map tab (the sheet is reached from both AR and List — both land on the map).
              setTracked(noradId);
              onClose();
              router.push("/map");
            }}
          >
            <Text style={styles.trackButtonText}>Show ground track</Text>
          </Pressable>
        ) : null}

        <ScrollView style={styles.txScroll} contentContainerStyle={styles.txContent}>
          {loading && <ActivityIndicator color={color.entity.orbit} />}
          {error && <Text style={styles.error}>{error}</Text>}
          {detail && transmitters.length === 0 && (
            <Text testID="sat-detail-empty" style={styles.empty}>
              No transmitter data
            </Text>
          )}
          {transmitters.map((tx, i) => {
            const active = isActive(tx);
            const modeBaud = [tx.mode, tx.baud != null ? `${tx.baud} bd` : null]
              .filter(Boolean)
              .join(" · ");
            const downlink = tx.downlinkLowHz != null ? formatFrequencyHz(tx.downlinkLowHz) : null;
            // Live Doppler only for an operational downlink we currently have a pass fix for.
            const corrected =
              active && tx.downlinkLowHz != null && view
                ? formatFrequencyHz(dopplerCorrectedHz(tx.downlinkLowHz, view.rangeRateKmS))
                : null;
            return (
              <View key={i} testID={`sat-tx-${i}`} style={styles.tx}>
                <View style={styles.txHead}>
                  <View style={[styles.dot, active ? styles.dotActive : styles.dotIdle]} />
                  <Text style={styles.txDesc} numberOfLines={2}>
                    {tx.description?.trim() || "Transmitter"}
                  </Text>
                </View>
                {modeBaud ? <Text style={styles.txMeta}>{modeBaud}</Text> : null}
                {downlink ? <Text style={styles.txDown}>↓ {downlink}</Text> : null}
                {corrected ? (
                  <Text testID={`sat-tx-doppler-${i}`} style={styles.txDoppler}>
                    Doppler {corrected}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </ScrollView>

        <Text style={styles.attribution}>
          Transmitters: SatNOGS DB (CC BY-SA) · Orbits: CelesTrak
        </Text>
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
  title: { color: "#EDE3FA", fontSize: 20, fontWeight: "700", flexShrink: 1 },
  chip: {
    backgroundColor: alpha(color.entity.orbit, 0.16),
    borderColor: alpha(color.entity.orbit, 0.8),
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  chipText: { color: color.entity.orbit, fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  norad: { color: color.textLabel, fontSize: 13, fontWeight: "600", marginLeft: "auto" },
  liveRows: { gap: 2, marginBottom: 8 },
  belowMask: { color: color.textLabel, fontSize: 13, fontStyle: "italic", marginBottom: 8 },
  passSection: {
    borderTopColor: color.surface2,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    marginBottom: 4,
    gap: 2,
  },
  passHeading: { color: color.entity.orbit, fontSize: 12, fontWeight: "700", textTransform: "uppercase" },
  passLine: { color: "#EDE3FA", fontSize: 14, fontWeight: "600" },
  passSub: { color: color.textDim, fontSize: 12 },
  passMuted: { color: color.textLabel, fontSize: 13, fontStyle: "italic" },
  // "👁 visible" pill — violet family like the group chip; the naked-eye "look up" cue for a visible pass.
  visibleBadge: {
    alignSelf: "flex-start",
    marginTop: 4,
    color: color.entity.orbit,
    fontSize: 12,
    fontWeight: "700",
    backgroundColor: alpha(color.entity.orbit, 0.16),
    borderColor: color.entity.orbit,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
    overflow: "hidden",
  },
  trackButton: {
    marginTop: 12,
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: alpha(color.entity.orbit, 0.16),
    borderColor: color.entity.orbit,
    borderWidth: StyleSheet.hairlineWidth,
  },
  trackButtonText: { color: color.entity.orbit, fontSize: 15, fontWeight: "700" },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  rowLabel: { color: color.textLabel, fontSize: 14 },
  rowValue: { color: color.text, fontSize: 14, fontWeight: "500" },
  txScroll: { flexGrow: 0 },
  txContent: { paddingTop: 4, gap: 8 },
  tx: {
    borderTopColor: color.surface2,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    gap: 2,
  },
  txHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotActive: { backgroundColor: "#4FD08A" },
  dotIdle: { backgroundColor: "#3a4a5a" },
  txDesc: { color: color.text, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  txMeta: { color: color.textDim, fontSize: 12, marginLeft: 16 },
  txDown: { color: "#EDE3FA", fontSize: 13, fontWeight: "500", marginLeft: 16 },
  txDoppler: { color: color.entity.orbit, fontSize: 13, fontWeight: "700", marginLeft: 16 },
  error: { color: color.status.error, marginVertical: 8 },
  empty: { color: color.textLabel, fontSize: 14, paddingVertical: 8 },
  attribution: { color: color.textMuted, fontSize: 11, marginTop: 12 },
  close: { marginTop: 16, alignItems: "center" },
  closeText: { color: color.entity.orbit, fontSize: 16 },
});
