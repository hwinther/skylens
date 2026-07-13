/**
 * List view: a tabular readout of the current traffic — type icon, callsign/name, distance + bearing
 * from you, and two trailing figures (aircraft: flight level + ground speed; ships: SOG + COG) —
 * merged into one nearest-first list. Same 1 Hz / 5 s stores as AR/Map. Tapping an aircraft, ship or
 * AtoN opens its detail sheet; tapping a satellite opens the overhead sheet. Cross-platform (no map deps).
 */

import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useAircraftList } from "@/state/aircraftStore";
import { useVesselList } from "@/state/vesselStore";
import { useSettingsStore } from "@/state/settingsStore";
import {
  DetailSheet,
  PlanetDetailSheet,
  SatelliteDetailSheet,
  VesselDetailSheet,
  usePlanets,
  useSatellites,
} from "@/components";
import { iconForCategory } from "@/components/aircraftIcon";
import { iconForVessel } from "@/components/vesselIcon";
import { compass8, relativePosition } from "@/components/webmap/relative";
import { satGroupsFromSettings } from "@/ar";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl, getHomeLocation } from "@/api/config";
import { DEMO_HOME } from "@/mock/mockFeed";

// Violet family — matches SatelliteLabel / the detail sheet; sets satellites apart from aircraft/ships.
const SAT_VIOLET = "#C792EA";
// Gold family — matches the AR planet labels; celestial bodies apart from every other domain's hue.
const PLANET_GOLD = "#FFCF5C";

export default function ListScreen() {
  const aircraft = useAircraftList();
  const vessels = useVesselList();
  const demoMode = useSettingsStore((s) => s.demoMode);
  const showShips = useSettingsStore((s) => s.showShips);
  const showAton = useSettingsStore((s) => s.showAton);
  const showSatellites = useSettingsStore((s) => s.showSatellites);
  const satAmateurStations = useSettingsStore((s) => s.satAmateurStations);
  const satWeather = useSettingsStore((s) => s.satWeather);
  const satGnss = useSettingsStore((s) => s.satGnss);
  const satElevationMaskDeg = useSettingsStore((s) => s.satElevationMaskDeg);
  const showPlanets = useSettingsStore((s) => s.showPlanets);
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [selectedMmsi, setSelectedMmsi] = useState<string | null>(null);
  const [selectedNoradId, setSelectedNoradId] = useState<number | null>(null);
  const [selectedPlanet, setSelectedPlanet] = useState<string | null>(null);
  const client = useMemo(() => new ApiClient({ baseUrl: getApiBaseUrl() }), []);
  const observer = useMemo(
    () => (demoMode ? DEMO_HOME : (getHomeLocation() ?? DEMO_HOME)),
    [demoMode],
  );

  // Same satellite source the AR screen uses — independent of the ADS-B hub, so it runs in demo and
  // live alike, gated only on the toggle. Groups/mask come from the shared settings derivation.
  const satGroups = useMemo(
    () =>
      satGroupsFromSettings({
        amateurStations: satAmateurStations,
        weather: satWeather,
        gnss: satGnss,
      }),
    [satAmateurStations, satWeather, satGnss],
  );
  const { visible: satellites, byNoradId } = useSatellites({
    client,
    observer,
    enabled: showSatellites,
    groups: satGroups,
    elevationMaskDeg: satElevationMaskDeg,
  });

  // Overhead list: satellites are overhead, not distance-sorted traffic — a separate section, ordered
  // highest-in-the-sky first (the hook returns group-priority order, so re-sort by elevation here).
  const overhead = useMemo(
    () => [...satellites].sort((a, b) => b.elevationDeg - a.elevationDeg),
    [satellites],
  );

  // Planets: pure on-device astronomy, independent of the hub — a "Sky" section ordered highest first.
  const { visible: planetViews, byBody } = usePlanets({ observer, enabled: showPlanets });
  const sky = useMemo(
    () => [...planetViews].sort((a, b) => b.elevationDeg - a.elevationDeg),
    [planetViews],
  );

  // Aircraft and (toggle-permitted) vessels merged into one list, sorted nearest-first. A per-row
  // kind discriminates the render — aircraft carry FL/GS, ships carry SOG/COG and their flag.
  const rows = useMemo(() => {
    const acRows = aircraft
      .filter((a) => a.lat != null && a.lon != null)
      .map((a) => ({
        kind: "aircraft" as const,
        key: `ac-${a.hex}`,
        a,
        ...relativePosition(observer, a.lat as number, a.lon as number),
      }));
    const shipRows = vessels
      .filter((v) => v.lat != null && v.lon != null && (v.kind === "aton" ? showAton : showShips))
      .map((v) => ({
        kind: "vessel" as const,
        key: `ship-${v.mmsi}`,
        v,
        icon: iconForVessel(v),
        ...relativePosition(observer, v.lat as number, v.lon as number),
      }));
    return [...acRows, ...shipRows].sort((x, y) => x.distanceKm - y.distanceKm);
  }, [aircraft, vessels, observer, showShips, showAton]);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <Text testID="list-count" style={styles.heading}>
        Traffic ({rows.length})
      </Text>
      <ScrollView testID="list-scroll">
        {rows.map((row) =>
          row.kind === "aircraft" ? (
            <Pressable
              key={row.key}
              testID={`list-ac-${row.a.hex}`}
              onPress={() => setSelectedHex(row.a.hex)}
              style={styles.row}
            >
              <MaterialCommunityIcons name={iconForCategory(row.a.cat)} size={18} color="#78C8FF" />
              <Text style={styles.callsign} numberOfLines={1}>
                {row.a.flight?.trim() || row.a.hex.toUpperCase()}
              </Text>
              <Text style={styles.meta}>
                {row.distanceKm.toFixed(1)} km {compass8(row.bearingDeg)}
              </Text>
              <Text style={styles.meta}>
                {row.a.fl != null ? `FL${String(row.a.fl).padStart(3, "0")}` : "—"}
              </Text>
              <Text style={styles.meta}>{row.a.gs != null ? `${Math.round(row.a.gs)} kt` : "—"}</Text>
            </Pressable>
          ) : (
            <Pressable
              key={row.key}
              testID={`list-ship-${row.v.mmsi}`}
              onPress={() => setSelectedMmsi(row.v.mmsi)}
              style={styles.row}
            >
              <MaterialCommunityIcons name={row.icon.name} size={18} color={row.icon.color} />
              <View style={styles.marineLabel}>
                <Text style={styles.shipName} numberOfLines={1}>
                  {row.v.name?.trim() || row.v.mmsi}
                </Text>
                {row.v.flag ? <Text style={styles.flag}>{row.v.flag}</Text> : null}
              </View>
              <Text style={styles.meta}>
                {row.distanceKm.toFixed(1)} km {compass8(row.bearingDeg)}
              </Text>
              <Text style={styles.meta}>{row.v.sog != null ? `${Math.round(row.v.sog)} kn` : "—"}</Text>
              <Text style={styles.meta}>{row.v.cog != null ? `${Math.round(row.v.cog)}°` : "—"}</Text>
            </Pressable>
          ),
        )}

        {showSatellites && (
          <>
            <Text testID="list-sat-count" style={styles.heading}>
              Overhead ({overhead.length})
            </Text>
            {overhead.map((s) => (
              <Pressable
                key={`sat-${s.noradId}`}
                testID={`list-sat-${s.noradId}`}
                onPress={() => setSelectedNoradId(s.noradId)}
                style={styles.row}
              >
                <MaterialCommunityIcons name="satellite-variant" size={18} color={SAT_VIOLET} />
                <Text style={styles.callsign} numberOfLines={1}>
                  {s.name.trim() || String(s.noradId)}
                </Text>
                <Text style={styles.meta}>
                  {Math.round(s.elevationDeg)}° {compass8(s.azimuthDeg)}
                </Text>
                <Text style={styles.meta}>{s.rangeKm.toFixed(0)} km</Text>
                {s.freqSummary ? (
                  <Text style={styles.satFreq} numberOfLines={1}>
                    {s.freqSummary}
                  </Text>
                ) : (
                  <Text style={styles.meta}>—</Text>
                )}
              </Pressable>
            ))}
          </>
        )}

        {showPlanets && (
          <>
            <Text testID="list-sky-count" style={styles.heading}>
              Sky ({sky.length})
            </Text>
            {sky.map((p) => (
              <Pressable
                key={`planet-${p.body}`}
                testID={`list-planet-${p.body}`}
                onPress={() => setSelectedPlanet(p.body)}
                style={styles.row}
              >
                <MaterialCommunityIcons name="star-four-points" size={18} color={PLANET_GOLD} />
                <Text style={styles.callsign} numberOfLines={1}>
                  {p.name}
                </Text>
                <Text style={styles.meta}>
                  {Math.round(p.elevationDeg)}° {compass8(p.azimuthDeg)}
                </Text>
                <Text style={styles.meta}>
                  {p.magnitude != null ? `${p.magnitude.toFixed(1)}m` : "—"}
                </Text>
                <Text style={styles.satFreq} numberOfLines={1}>
                  {p.constellation ?? ""}
                </Text>
              </Pressable>
            ))}
          </>
        )}
      </ScrollView>
      <DetailSheet hex={selectedHex} client={client} onClose={() => setSelectedHex(null)} />
      <VesselDetailSheet
        mmsi={selectedMmsi}
        vessel={selectedMmsi != null ? vessels.find((v) => v.mmsi === selectedMmsi) : undefined}
        onClose={() => setSelectedMmsi(null)}
      />
      <SatelliteDetailSheet
        noradId={selectedNoradId}
        view={selectedNoradId != null ? byNoradId.get(selectedNoradId) : undefined}
        observer={observer}
        elevationMaskDeg={satElevationMaskDeg}
        onClose={() => setSelectedNoradId(null)}
      />
      <PlanetDetailSheet
        body={selectedPlanet}
        view={selectedPlanet != null ? byBody.get(selectedPlanet) : undefined}
        observer={observer}
        onClose={() => setSelectedPlanet(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B1622" },
  heading: { color: "#EAF6FF", fontSize: 18, fontWeight: "700", paddingHorizontal: 16, paddingVertical: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderBottomColor: "#16283a",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  callsign: { color: "#EAF6FF", fontSize: 14, fontWeight: "600", flex: 1 },
  marineLabel: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6 },
  shipName: { color: "#EAF6FF", fontSize: 14, fontWeight: "600", flexShrink: 1 },
  flag: { color: "#9FC7E0", fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  meta: { color: "#9FC7E0", fontSize: 12, minWidth: 74, textAlign: "right" },
  satFreq: { color: "#C3A9E0", fontSize: 12, minWidth: 74, textAlign: "right" },
});
