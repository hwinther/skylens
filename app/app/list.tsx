/**
 * List view: a tabular readout of the current traffic — type icon, callsign/name, distance + bearing
 * from you, and two trailing figures (aircraft: flight level + ground speed; ships: SOG + COG) —
 * merged into one nearest-first list. Same 1 Hz / 5 s stores as AR/Map. Tapping an aircraft, ship or
 * AtoN opens its detail sheet; tapping a satellite opens the overhead sheet. Cross-platform (no map deps).
 */

import { color } from "@/theme";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useAircraftList } from "@/state/aircraftStore";
import { useVesselList } from "@/state/vesselStore";
import { useSettingsStore } from "@/state/settingsStore";
import {
  DetailSheet,
  EmptyState,
  PlanetDetailSheet,
  RadioDetailSheet,
  SatelliteDetailSheet,
  VesselDetailSheet,
  usePlanets,
  useRadioSky,
  useSatellites,
} from "@/components";
import { iconForCategory } from "@/components/aircraftIcon";
import { iconForVessel } from "@/components/vesselIcon";
import { compass8, relativePosition } from "@/components/webmap/relative";
import { RADIO_SOURCES, satGroupsFromSettings } from "@/ar";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl, getHomeLocation } from "@/api/config";
import { DEMO_HOME } from "@/mock/mockFeed";

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
  const showRadioSky = useSettingsStore((s) => s.showRadioSky);
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [selectedMmsi, setSelectedMmsi] = useState<string | null>(null);
  const [selectedNoradId, setSelectedNoradId] = useState<number | null>(null);
  const [selectedPlanet, setSelectedPlanet] = useState<string | null>(null);
  const [selectedRadioKey, setSelectedRadioKey] = useState<string | null>(null);
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

  // Radio sources: same pure on-device astronomy — a "Radio" section ordered highest-in-the-sky first.
  const { visible: radioViews, byKey } = useRadioSky({ observer, enabled: showRadioSky });
  const radioRows = useMemo(
    () => [...radioViews].sort((a, b) => b.elevationDeg - a.elevationDeg),
    [radioViews],
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

  // Family split for the Traffic heading breakdown (air = aircraft, sea = vessels).
  const acCount = rows.filter((r) => r.kind === "aircraft").length;
  const shipCount = rows.length - acCount;

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.headingRow}>
        <View style={styles.headingLeft}>
          <View style={[styles.headingDot, { backgroundColor: color.entity.air }]} />
          <Text testID="list-count" style={styles.heading}>
            Traffic ({rows.length})
          </Text>
        </View>
        {rows.length > 0 ? (
          <Text style={styles.headingBreakdown}>
            {acCount} air · {shipCount} sea
          </Text>
        ) : null}
      </View>
      <ScrollView testID="list-scroll">
        {rows.length === 0 ? (
          <EmptyState
            icon="radar"
            title="No traffic in range"
            message="No aircraft or ships are being received right now. They'll appear here the moment they're picked up."
            actionLabel="Check data sources"
            onAction={() => router.push("/settings")}
          />
        ) : (
          rows.map((row) =>
            row.kind === "aircraft" ? (
            <Pressable
              key={row.key}
              testID={`list-ac-${row.a.hex}`}
              onPress={() => setSelectedHex(row.a.hex)}
              style={styles.row}
            >
              <MaterialCommunityIcons name={iconForCategory(row.a.cat)} size={18} color={color.entity.air} />
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
                {row.icon.tag ? (
                  <Text style={[styles.classTag, { backgroundColor: row.icon.color }]}>
                    {row.icon.tag}
                  </Text>
                ) : null}
                {row.v.flag ? <Text style={styles.flag}>{row.v.flag}</Text> : null}
              </View>
              <Text style={styles.meta}>
                {row.distanceKm.toFixed(1)} km {compass8(row.bearingDeg)}
              </Text>
              <Text style={styles.meta}>{row.v.sog != null ? `${Math.round(row.v.sog)} kn` : "—"}</Text>
              <Text style={styles.meta}>{row.v.cog != null ? `${Math.round(row.v.cog)}°` : "—"}</Text>
            </Pressable>
          ),
          )
        )}

        {showSatellites && (
          <>
            <View style={styles.headingLeft}>
              <View style={[styles.headingDot, { backgroundColor: color.entity.orbit }]} />
              <Text testID="list-sat-count" style={styles.heading}>
                Overhead ({overhead.length})
              </Text>
            </View>
            {overhead.length === 0 ? (
              <Text style={styles.emptyLine}>No passes overhead right now.</Text>
            ) : (
              overhead.map((s) => (
              <Pressable
                key={`sat-${s.noradId}`}
                testID={`list-sat-${s.noradId}`}
                onPress={() => setSelectedNoradId(s.noradId)}
                style={styles.row}
              >
                <MaterialCommunityIcons name="satellite-variant" size={18} color={color.entity.orbit} />
                <Text style={styles.callsign} numberOfLines={1}>
                  {s.name.trim() || String(s.noradId)}
                </Text>
                {s.visibleNow ? (
                  // Sunlit right now over a dark sky — the "look up, you can see it" cue (see visibility.ts).
                  <MaterialCommunityIcons
                    testID={`list-sat-eye-${s.noradId}`}
                    name="eye"
                    size={16}
                    color={color.entity.orbit}
                  />
                ) : null}
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
            ))
            )}
          </>
        )}

        {showPlanets && (
          <>
            <View style={styles.headingLeft}>
              <View style={[styles.headingDot, { backgroundColor: color.entity.sky }]} />
              <Text testID="list-sky-count" style={styles.heading}>
                Sky ({sky.length})
              </Text>
            </View>
            {sky.length === 0 ? (
              <Text style={styles.emptyLine}>No planets above the horizon right now.</Text>
            ) : (
              sky.map((p) => (
              <Pressable
                key={`planet-${p.body}`}
                testID={`list-planet-${p.body}`}
                onPress={() => setSelectedPlanet(p.body)}
                style={styles.row}
              >
                <MaterialCommunityIcons name="star-four-points" size={18} color={color.entity.sky} />
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
            ))
            )}
          </>
        )}

        {showRadioSky && (
          <>
            <View style={styles.headingLeft}>
              <View style={[styles.headingDot, { backgroundColor: color.entity.radio }]} />
              <Text testID="list-radio-count" style={styles.heading}>
                Radio ({radioRows.length})
              </Text>
            </View>
            {radioRows.length === 0 ? (
              <Text style={styles.emptyLine}>No radio sources above the horizon right now.</Text>
            ) : (
              radioRows.map((r) => (
              <Pressable
                key={`radio-${r.key}`}
                testID={`list-radio-${r.key}`}
                onPress={() => setSelectedRadioKey(r.key)}
                style={styles.row}
              >
                <MaterialCommunityIcons name="radio-tower" size={18} color={color.entity.radio} />
                <Text style={styles.callsign} numberOfLines={1}>
                  {r.short}
                </Text>
                <Text style={styles.meta}>
                  {Math.round(r.elevationDeg)}° {compass8(r.azimuthDeg)}
                </Text>
              </Pressable>
            ))
            )}
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
      <RadioDetailSheet
        sourceKey={selectedRadioKey}
        view={selectedRadioKey != null ? byKey.get(selectedRadioKey) : undefined}
        source={
          selectedRadioKey != null
            ? RADIO_SOURCES.find((s) => s.key === selectedRadioKey)
            : undefined
        }
        observer={observer}
        onClose={() => setSelectedRadioKey(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  heading: { color: color.text, fontSize: 18, fontWeight: "700", paddingHorizontal: 16, paddingVertical: 12 },
  headingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingRight: 16 },
  headingLeft: { flexDirection: "row", alignItems: "center" },
  // Domain-coded dot sits in the 16px gutter; negative right margin trims the heading's own left padding.
  headingDot: { width: 8, height: 8, borderRadius: 4, marginLeft: 16, marginRight: -8 },
  headingBreakdown: { color: color.textDim, fontSize: 13, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderBottomColor: color.surface2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  callsign: { color: color.text, fontSize: 14, fontWeight: "600", flex: 1 },
  marineLabel: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6 },
  shipName: { color: color.text, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  flag: { color: color.textDim, fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  // Ship-class tag badge (H/P/C/T): same triple-coding as the AR label — hue + shape + letter.
  classTag: {
    fontSize: 9,
    fontWeight: "700",
    color: color.bg,
    borderRadius: 3,
    paddingHorizontal: 3,
    overflow: "hidden",
  },
  meta: { color: color.textDim, fontSize: 12, minWidth: 74, textAlign: "right" },
  satFreq: { color: "#C3A9E0", fontSize: 12, minWidth: 74, textAlign: "right" },
  emptyLine: { color: color.textMuted, fontSize: 13, paddingHorizontal: 16, paddingBottom: 12 },
});
