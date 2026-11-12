/**
 * Aircraft detail bottom sheet. Opens on label tap, fetches GET /api/aircraft/{hex}
 * for metadata (registration/type/operator). The "Route" button is the ONLY thing
 * that calls GET /api/aircraft/{hex}/route — that endpoint spends AeroAPI quota, so
 * it must be an explicit user action, never automatic.
 *
 * Without API access (signed out behind real auth, e.g. in demo mode) it fetches nothing and shows
 * what the live snapshot already carries.
 */

import { color } from "@/theme";
import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { awaySourceCredit, creditText } from "./awaySource";
import { Sheet } from "./Sheet";
import { ShowOnMapButton } from "./ShowOnMapButton";
import { SimulatorButton } from "./SimulatorButton";
import type { ApiClient } from "@/api/client";
import { useAircraftStore } from "@/state/aircraftStore";
import { useApiAllowed } from "@/state/authStore";
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
  // Away-mode aircraft (adsb.lol / airplanes.live / adsb.fi / ADSBx) aren't in the backend's own-feed store, so the detail
  // response carries metadata only; fall back to the live snapshot entry for the state fields.
  const live = useAircraftStore((s) => (hex ? s.byHex[hex] : undefined));
  const state = detail?.state ?? live ?? null;
  // Away-mode traffic carries its aggregator in `src`; credit it (adsb.fi's terms require a link).
  const credit = awaySourceCredit(state?.src);
  const apiAllowed = useApiAllowed();

  useEffect(() => {
    setDetail(null);
    setRoute(null);
    setError(null);
    if (!hex || !apiAllowed) return;
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
  }, [hex, client, apiAllowed]);

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
        {(detail || (!apiAllowed && state)) && (
          <>
            <Text testID="detail-title" style={styles.title}>
              {state?.flight?.trim() ||
                (state?.hex ?? detail?.metadata?.hex ?? hex ?? "").toUpperCase()}
            </Text>
            <Row label="Registration" value={detail?.metadata?.registration} />
            <Row label="Type" value={detail?.metadata?.typeName ?? detail?.metadata?.typeCode} />
            <Row label="Operator" value={detail?.metadata?.operator} />
            {detail?.metadata?.military || state?.mil ? (
              <Row label="Military" value="Yes (registry flag)" />
            ) : null}
            <Row
              label="Altitude"
              value={state?.alt != null ? `${state.alt.toLocaleString()} ft` : null}
            />
            <Row
              label="Ground speed"
              value={state?.gs != null ? `${Math.round(state.gs)} kt` : null}
            />
            <Row label="Source" value={credit?.name ?? state?.src ?? detail?.metadata?.source} />

            {!apiAllowed && (
              <Text testID="detail-signin-hint" style={styles.hint}>
                Sign in for registration, type, operator and route.
              </Text>
            )}

            {apiAllowed && !route && (
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

        {/* Outside the detail block: the live position is enough to show it on the map, even when
            the detail fetch failed (backend unreachable, unknown aircraft). */}
        {hex && state?.lat != null && state?.lon != null && (
          <ShowOnMapButton
            testID="detail-show-on-map"
            focus={{ kind: "aircraft", hex }}
            accent={color.entity.air}
            onClose={onClose}
          />
        )}
        {hex && state?.lat != null && state?.lon != null && (
          <SimulatorButton
            testID="detail-cockpit"
            target={{ kind: "aircraft", id: hex }}
            accent={color.entity.air}
            onClose={onClose}
          />
        )}

        {credit && (
          <Pressable testID="detail-source-credit" onPress={() => void Linking.openURL(credit.url)}>
            <Text style={styles.attribution}>{creditText(credit)}</Text>
          </Pressable>
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
  hint: { color: color.textMuted, fontSize: 12, marginTop: 12 },
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
  attribution: { color: color.textMuted, fontSize: 11, marginTop: 12, textDecorationLine: "underline" },
});
