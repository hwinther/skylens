/**
 * Aircraft detail card. Opens on label tap, fetches GET /api/aircraft/{hex}
 * for metadata (registration/type/operator). The "Route" button is the ONLY thing
 * that calls GET /api/aircraft/{hex}/route — that endpoint spends AeroAPI quota, so
 * it must be an explicit user action, never automatic.
 *
 * Without API access (signed out behind real auth, e.g. in demo mode) it fetches nothing and shows
 * what the live snapshot already carries.
 */

import { color } from "@/theme";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { awaySourceCredit, creditText } from "./awaySource";
import { aircraftIdentityLines } from "./cockpitSummary";
import { Sheet, sheetActionStyle, SheetSummary, sheetSummaryLines } from "./Sheet";
import { ShowOnMapButton } from "./ShowOnMapButton";
import { SimulatorButton } from "./SimulatorButton";
import { useObserver } from "./useObserver";
import { compass8, relativePosition } from "./webmap/relative";
import type { ApiClient } from "@/api/client";
import { useAircraftStore } from "@/state/aircraftStore";
import { useApiAllowed } from "@/state/authStore";
import type { AircraftDetail, RouteResponse } from "@/api/types";

export interface DetailSheetProps {
  hex: string | null;
  client: ApiClient;
  onClose: () => void;
  /** Side-panel layout only: offset from the top of the screen (see Sheet). */
  panelTop?: number;
  /** The AR view's tracker says this aircraft's signal is lost (src/ar/signalLost): show a status line. */
  signalLost?: boolean;
  /**
   * Replaces the "Cockpit view" action (the cockpit view passes its own "Follow this", or null for the
   * aircraft it already follows). Undefined keeps the default.
   */
  cockpitAction?: ReactNode;
  /** Measure the summary's distance from here instead of the observer (the cockpit's followed object). */
  relativeTo?: { lat: number; lon: number } | null;
  /**
   * A route became known for `hex`: the free cached read on open, or the user's own tap on the paid
   * "Route" button. Never triggers a fetch itself (the cockpit view draws the route line from it).
   */
  onRoute?: (hex: string, route: RouteResponse) => void;
  /**
   * The collapsed summary says what the aircraft is (type, registration, operator, route) instead of
   * its live altitude / speed / distance: the cockpit view's followed aircraft, whose HUD shows those.
   */
  identitySummary?: boolean;
  /** False drops "Show on map" (the cockpit view's own Map chip / minimap does that). Default true. */
  mapAction?: boolean;
}

export function DetailSheet({
  hex,
  client,
  onClose,
  panelTop,
  signalLost = false,
  cockpitAction,
  relativeTo,
  onRoute,
  identitySummary = false,
  mapAction = true,
}: DetailSheetProps) {
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
  // Distance in the collapsed summary, measured from the same observer the List uses.
  const observer = useObserver();
  const origin = relativeTo ?? observer;
  // Read from async callbacks: the latest callback, and the hex the card shows now.
  const onRouteRef = useRef(onRoute);
  const hexRef = useRef(hex);
  useEffect(() => {
    onRouteRef.current = onRoute;
    hexRef.current = hex;
  });

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
      if (cancelled || !r) return;
      setRoute(r);
      onRouteRef.current?.(hex, r);
    });
    return () => {
      cancelled = true;
    };
  }, [hex, client, apiAllowed]);

  const loadRoute = () => {
    if (!hex) return;
    const forHex = hex;
    setRouteLoading(true);
    client
      .aircraftRoute(forHex)
      .then((r) => {
        // The card may show another aircraft by now: that one's route is not this.
        if (hexRef.current !== forHex) return;
        setRoute(r);
        onRouteRef.current?.(forHex, r);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Route failed"))
      .finally(() => setRouteLoading(false));
  };

  const ready = !!detail || (!apiAllowed && !!state);
  const title =
    state?.flight?.trim() || (state?.hex ?? detail?.metadata?.hex ?? hex ?? "").toUpperCase();
  const positioned = hex != null && state?.lat != null && state?.lon != null;
  const rel = positioned ? relativePosition(origin, state!.lat!, state!.lon!) : null;

  return (
    <Sheet
      visible={!!hex}
      panelTop={panelTop}
      onClose={onClose}
      accent={color.entity.air}
      label="Aircraft details"
      header={
        <View style={styles.header}>
          {/* The callsign shows straight away from the live snapshot; the "detail-title" testID only
              lands once the detail fetch has resolved (or there is no API access), as before. */}
          <Text
            testID={ready ? "detail-title" : "detail-title-pending"}
            style={styles.title}
            numberOfLines={1}
          >
            {title}
          </Text>
          {loading && <ActivityIndicator size="small" color={color.entity.air} />}
        </View>
      }
      summary={
        identitySummary ? (
          sheetSummaryLines(
            aircraftIdentityLines({
              metadata: detail?.metadata,
              route,
              hex: state?.hex ?? hex,
              hasCallsign: !!state?.flight?.trim(),
              military: !!(detail?.metadata?.military || state?.mil),
              signalLost,
            }),
          )
        ) : (
          <SheetSummary
            parts={[
              signalLost && "Signal lost",
              detail?.metadata?.typeCode,
              state?.alt != null ? `${state.alt.toLocaleString()} ft` : null,
              state?.gs != null ? `${Math.round(state.gs)} kt` : null,
              rel ? `${rel.distanceKm.toFixed(1)} km ${compass8(rel.bearingDeg)}` : null,
            ]}
          />
        )
      }
      actions={
        positioned && (mapAction || cockpitAction !== null) ? (
          // The live position is enough to show it on the map, even when the detail fetch failed
          // (backend unreachable, unknown aircraft).
          <>
            {mapAction ? (
              <ShowOnMapButton
                testID="detail-show-on-map"
                focus={{ kind: "aircraft", hex }}
                accent={color.entity.air}
                onClose={onClose}
                style={sheetActionStyle}
              />
            ) : null}
            {cockpitAction !== undefined ? (
              cockpitAction
            ) : (
              <SimulatorButton
                testID="detail-cockpit"
                target={{ kind: "aircraft", id: hex }}
                accent={color.entity.air}
                onClose={onClose}
                style={sheetActionStyle}
              />
            )}
          </>
        ) : null
      }
    >
        {signalLost && (
          <Text testID="detail-signal-lost" style={styles.lost}>
            Signal lost — showing the last known position
          </Text>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
        {ready && (
          <>
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
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: color.text, fontSize: 20, fontWeight: "700", flexShrink: 1 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  rowLabel: { color: color.textLabel, fontSize: 14 },
  rowValue: { color: color.text, fontSize: 14, fontWeight: "500" },
  error: { color: color.status.error, marginVertical: 8 },
  lost: { color: color.status.warn, fontSize: 13, fontWeight: "600", marginBottom: 6 },
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
