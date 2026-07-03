/**
 * Aircraft detail bottom sheet. Opens on label tap, fetches GET /api/aircraft/{hex}
 * for metadata (registration/type/operator). The "Route" button is the ONLY thing
 * that calls GET /api/aircraft/{hex}/route — that endpoint spends AeroAPI quota, so
 * it must be an explicit user action, never automatic.
 */

import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { ApiClient } from "@/api/client";
import type { AircraftDetail, RouteResponse } from "@/api/types";

export interface DetailSheetProps {
  hex: string | null;
  client: ApiClient;
  onClose: () => void;
}

export function DetailSheet({ hex, client, onClose }: DetailSheetProps) {
  const [detail, setDetail] = useState<AircraftDetail | null>(null);
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [routeLoading, setRouteLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setRoute(null);
    setError(null);
    if (!hex) return;
    let cancelled = false;
    setLoading(true);
    client
      .aircraftDetail(hex)
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
  }, [hex, client]);

  const loadRoute = () => {
    if (!hex) return;
    setRouteLoading(true);
    client
      .aircraftRoute(hex)
      .then(setRoute)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Route failed"))
      .finally(() => setRouteLoading(false));
  };

  return (
    <Modal visible={!!hex} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        {loading && <ActivityIndicator color="#78C8FF" />}
        {error && <Text style={styles.error}>{error}</Text>}
        {detail && (
          <>
            <Text testID="detail-title" style={styles.title}>
              {detail.state?.flight?.trim() ||
                (detail.state?.hex ?? detail.metadata?.hex ?? hex ?? "").toUpperCase()}
            </Text>
            <Row label="Registration" value={detail.metadata?.registration} />
            <Row label="Type" value={detail.metadata?.typeName ?? detail.metadata?.typeCode} />
            <Row label="Operator" value={detail.metadata?.operator} />
            <Row
              label="Altitude"
              value={detail.state?.alt != null ? `${detail.state.alt.toLocaleString()} ft` : null}
            />
            <Row
              label="Ground speed"
              value={detail.state?.gs != null ? `${Math.round(detail.state.gs)} kt` : null}
            />
            <Row label="Source" value={detail.state?.src ?? detail.metadata?.source} />

            <Pressable style={styles.routeBtn} onPress={loadRoute} disabled={routeLoading}>
              <Text style={styles.routeBtnText}>
                {routeLoading ? "Loading route…" : "Route (uses AeroAPI)"}
              </Text>
            </Pressable>

            {route && (
              <View style={styles.route}>
                <Text style={styles.routeText}>
                  {route.originIcao ?? "?"} → {route.destinationIcao ?? "?"}
                </Text>
                {route.originName && route.destinationName && (
                  <Text style={styles.routeSub}>
                    {route.originName} → {route.destinationName}
                  </Text>
                )}
              </View>
            )}
          </>
        )}
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
    backgroundColor: "#0B1622",
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
    backgroundColor: "#33506b",
    marginBottom: 12,
  },
  title: { color: "#EAF6FF", fontSize: 20, fontWeight: "700", marginBottom: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  rowLabel: { color: "#7fa6c4", fontSize: 14 },
  rowValue: { color: "#EAF6FF", fontSize: 14, fontWeight: "500" },
  error: { color: "#ff8a80", marginVertical: 8 },
  routeBtn: {
    marginTop: 16,
    backgroundColor: "#12507a",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  routeBtnText: { color: "#EAF6FF", fontWeight: "600" },
  route: { marginTop: 12 },
  routeText: { color: "#EAF6FF", fontSize: 16, fontWeight: "600" },
  routeSub: { color: "#9FC7E0", fontSize: 12, marginTop: 2 },
  close: { marginTop: 20, alignItems: "center" },
  closeText: { color: "#78C8FF", fontSize: 16 },
});
