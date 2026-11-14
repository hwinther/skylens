/**
 * The cockpit view's extras, shared by the web screen (SimScreen.web.tsx) and the Android screen
 * (SimScreen.tsx): what the detail card shows, the layer filter, the camera mode, the other traffic for
 * the 3D scene (re-selected at TRAFFIC_UPDATE_MS from the live stores), and the HUD's navigation aids
 * (nearest airport/port, destination). The screens own the globe and feed it what this returns: the web
 * screen calls the SimGlobe handle, the Android screen passes props into the webview.
 *
 * Traffic comes from the live stores (centred on the followed object while the session runs), places
 * from the label fetches the globe already makes (handed in via `onPlaces`), and a route only from the
 * detail card (`onRoute`: its free cached read on open, or the user's own tap on the paid "Route"
 * button). The one call of its own: when that route's destination is not among the nearby airports,
 * one GET /api/airports/{ident} per code (offline database, free; behind the API gate, remembered for
 * the screen's life, a failure just means no line), so the route line shows from any distance.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl } from "@/api/config";
import type { RouteResponse } from "@/api/types";
import { AirportLookup } from "@/sim/airportLookup";
import type { CameraMode } from "@/sim/chase";
import { hiddenSummary, simFilterChips, simLayerVisibility, type SimLayer } from "@/sim/layers";
import type { OverlayLayerKind, OverlayPlace } from "@/sim/overlay";
import { describeDestination, describeNearest, findPlaceByCode, nearestPlace, type GeoPos } from "@/sim/route";
import type { HudRow } from "@/sim/hud";
import { selectTraffic, trafficKey, TRAFFIC_UPDATE_MS, type TrafficItem, type TrafficPick } from "@/sim/traffic";
import type { TrackedPose } from "@/sim/tracker";
import { useAircraftStore } from "@/state/aircraftStore";
import { isApiAllowed } from "@/state/authStore";
import { useSettingsStore } from "@/state/settingsStore";
import { useSimStore, type SimTarget } from "@/state/simStore";
import { useVesselStore } from "@/state/vesselStore";

/** What the cockpit's detail card shows: the followed object, or another one the user tapped. */
export type SimSelection = SimTarget;

export interface SimCockpitOptions {
  target: SimTarget | null;
  /** The screen is focused (the 1 Hz traffic loop only runs then). */
  focused: boolean;
  /** New traffic for the globe; only called when it changed. */
  onTraffic: (items: TrafficItem[]) => void;
}

export function useSimCockpit({ target, focused, onTraffic }: SimCockpitOptions) {
  const router = useRouter();
  const start = useSimStore((s) => s.start);
  const targetKey = target ? `${target.kind}:${target.id}` : "";

  // --- the card: open on the followed object at first (collapsed), one selection at a time ----------
  // Remembered per followed object: a new one (Follow this, a deep link) shows its own card again.
  const [chosen, setChosen] = useState<{ forTarget: string; selection: SimSelection | null } | null>(null);
  const selection = chosen && chosen.forTarget === targetKey ? chosen.selection : target;
  const setSelection = useCallback(
    (next: SimSelection | null) => setChosen({ forTarget: targetKey, selection: next }),
    [targetKey],
  );
  const select = useCallback((pick: TrafficPick) => setSelection({ kind: pick.kind, id: pick.id }), [setSelection]);
  const showDetails = useCallback(() => setSelection(target), [setSelection, target]);
  const closeCard = useCallback(() => setSelection(null), [setSelection]);

  /** Re-target the cockpit at another object (the card's "Follow this"): same session handoff as a card. */
  const follow = useCallback(
    (next: SimTarget) => {
      start(next);
      router.setParams({ kind: next.kind, id: next.id });
    },
    [start, router],
  );

  // --- camera mode ------------------------------------------------------------------------------
  const [cameraMode, setCameraMode] = useState<CameraMode>("cockpit");
  const toggleCamera = useCallback(() => setCameraMode((m) => (m === "cockpit" ? "chase" : "cockpit")), []);

  // --- layer filter (persisted) ---------------------------------------------------------------------
  const hidden = useSettingsStore((s) => s.simHiddenLayers);
  const toggleLayer = useSettingsStore((s) => s.toggleSimLayer);
  const chips = useMemo(() => (target ? simFilterChips(target.kind, hidden) : []), [target, hidden]);
  const visibility = useMemo(() => simLayerVisibility(hidden), [hidden]);
  const [filterOpen, setFilterOpen] = useState(false);
  const toggleFilter = useCallback(() => setFilterOpen((o) => !o), []);
  const filterSummary = hiddenSummary(chips);

  // --- places (from the label fetches) and routes (from the card) -------------------------------------
  const placesRef = useRef<Partial<Record<OverlayLayerKind, OverlayPlace[]>>>({});
  const onPlaces = useCallback((layer: OverlayLayerKind, places: OverlayPlace[]) => {
    placesRef.current[layer] = places;
  }, []);
  const routesRef = useRef<Record<string, RouteResponse>>({});
  const onRoute = useCallback((hex: string, route: RouteResponse) => {
    routesRef.current[hex] = route;
  }, []);
  // Destinations beyond the nearby airports: one offline lookup per code, kept for the screen's life.
  const [airportLookup] = useState(() => {
    const client = new ApiClient({ baseUrl: getApiBaseUrl() });
    return new AirportLookup({ fetchAirport: (ident) => client.airport(ident), allowed: isApiAllowed });
  });

  // --- the 1 Hz loop: traffic for the globe, nav aids for the HUD --------------------------------------
  /** The followed object's pose, kept current by the screen's HUD timer. */
  const poseRef = useRef<TrackedPose | null>(null);
  const onTrafficRef = useRef(onTraffic);
  useEffect(() => {
    onTrafficRef.current = onTraffic;
  });
  const [navRows, setNavRows] = useState<HudRow[]>([]);
  const [destination, setDestination] = useState<GeoPos | null>(null);
  const visibilityRef = useRef(visibility);
  useEffect(() => {
    visibilityRef.current = visibility;
  }, [visibility]);

  const sentTraffic = useRef(trafficKey([]));
  const tick = useCallback(() => {
    if (!target) return;
    const pose = poseRef.current;
    const now = Date.now();
    if (target.kind !== "satellite" && pose) {
      const ac = useAircraftStore.getState();
      const vs = useVesselStore.getState();
      const items = selectTraffic({
        aircraft: ac.byHex,
        aircraftAt: ac.lastSnapshotAt,
        vessels: vs.byMmsi,
        vesselsAt: vs.lastSnapshotAt,
        centre: pose,
        followed: target,
        ownAltM: target.kind === "aircraft" ? pose.altM : null,
        show: { aircraft: visibilityRef.current.aircraft, vessels: visibilityRef.current.vessels },
        nowMs: now,
      });
      const key = trafficKey(items);
      if (key !== sentTraffic.current) {
        sentTraffic.current = key;
        onTrafficRef.current(items);
      }
    }

    // Nav aids: nearest airport (aircraft) / port (vessel), and the destination when a route is known.
    const rows: HudRow[] = [];
    let dest: GeoPos | null = null;
    if (pose && target.kind !== "satellite") {
      const places =
        target.kind === "aircraft" ? (placesRef.current.airports ?? []) : (placesRef.current.ports ?? []);
      const near = nearestPlace(places, pose.lat, pose.lon);
      if (near) rows.push([target.kind === "aircraft" ? "APT" : "PORT", describeNearest(near), "sim-nearest"]);
      const code = target.kind === "aircraft" ? routesRef.current[target.id]?.destinationIcao?.trim() : null;
      if (code) {
        const nearbyAirports = placesRef.current.airports;
        const nearby = findPlaceByCode(nearbyAirports ?? [], code);
        // Only once the nearby airports are in (not ahead of them), and only for one that isn't among them.
        const looked = nearby || !nearbyAirports ? null : airportLookup.resolve(code);
        const place = nearby ?? (looked && looked !== "pending" ? looked : null);
        rows.push(["DEST", describeDestination(code, pose, place), "sim-dest"]);
        if (place) dest = { lat: place.lat, lon: place.lon, altM: place.altM };
      }
    }
    setNavRows((prev) => (JSON.stringify(prev) === JSON.stringify(rows) ? prev : rows));
    setDestination((prev) =>
      prev?.lat === dest?.lat && prev?.lon === dest?.lon && prev?.altM === dest?.altM ? prev : dest,
    );
  }, [target, airportLookup]);

  useEffect(() => {
    if (!focused || !target) return;
    // A new target starts from scratch: no traffic, places or route carried over (the session is new).
    sentTraffic.current = trafficKey([]);
    onTrafficRef.current([]);
    const timer = setInterval(tick, TRAFFIC_UPDATE_MS);
    return () => clearInterval(timer);
  }, [focused, target, tick]);

  // A filter change shows at once, not on the next tick.
  useEffect(() => {
    if (!focused) return;
    const t = setTimeout(tick, 0);
    return () => clearTimeout(t);
  }, [visibility, focused, tick]);

  return {
    selection,
    select,
    showDetails,
    closeCard,
    follow,
    cameraMode,
    toggleCamera,
    chips,
    toggleLayer: toggleLayer as (layer: SimLayer) => void,
    visibility,
    filterOpen,
    toggleFilter,
    filterSummary,
    onPlaces,
    onRoute,
    poseRef,
    navRows,
    destination,
  };
}

export type SimCockpit = ReturnType<typeof useSimCockpit>;
