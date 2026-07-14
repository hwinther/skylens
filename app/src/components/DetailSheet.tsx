/**
 * Aircraft detail bottom sheet. Opens on label tap, fetches GET /api/aircraft/{hex}
 * for metadata (registration/type/operator). The "Route" button is the ONLY thing
 * that calls GET /api/aircraft/{hex}/route — that endpoint spends AeroAPI quota, so
 * it must be an explicit user action, never automatic.
 */

import { color } from "@/theme";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Sheet } from "./Sheet";
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
    // Show a route immediately if the backend already has it cached (free — no AeroAPI spend). The
    // "Route" button below still triggers the paid first-fetch for anything not yet cached.
    client.aircraftRouteCached(hex).then((r) => {
      if (!cancelled && r) setRoute(r);
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
    <Sheet visible={!!hex} onClose={onClose} accent={color.entity.air}>
        {loading && <ActivityIndicator color={color.entity.air} />}
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

            {!route && (
              <Pressable style={styles.routeBtn} onPress={loadRoute} disabled={routeLoading}>
                <Text style={styles.routeBtnText}>
                  {routeLoading ? "Loading route…" : "Route (uses AeroAPI)"}
                </Text>
              </Pressable>
            )}

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
    </Sheet>
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
  title: { color: color.text, fontSize: 20, fontWeight: "700", marginBottom: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  rowLabel: { color: color.textLabel, fontSize: 14 },
  rowValue: { color: color.text, fontSize: 14, fontWeight: "500" },
  error: { color: color.status.error, marginVertical: 8 },
  routeBtn: {
    marginTop: 16,
    backgroundColor: color.accentFill,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  routeBtnText: { color: color.text, fontWeight: "600" },
  route: { marginTop: 12 },
  routeText: { color: color.text, fontSize: 16, fontWeight: "600" },
  routeSub: { color: color.textDim, fontSize: 12, marginTop: 2 },
});
