/**
 * Native Map view: two spatial renderings, switchable — Radar (you-centric, offline) and the real
 * react-native-maps MapView. Reads the same 1 Hz store; tapping a marker/blip opens the detail sheet.
 * Web has no react-native-maps — see MapScreen.web.tsx (Leaflet). The flat list lives in the List tab.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MapView, { Marker, Polygon, Polyline } from "react-native-maps";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { AircraftDto, AirportDto, FishingZone, LostGear, VesselDto } from "@/api/types";
import { useAircraftList } from "@/state/aircraftStore";
import { useVesselList } from "@/state/vesselStore";
import { useSettingsStore } from "@/state/settingsStore";
import {
  DetailSheet,
  AircraftRadar,
  AirportDetailSheet,
  VesselDetailSheet,
  useAirports,
  useFishingLayers,
  useSatelliteGroundTrack,
} from "@/components";
import { iconForVessel } from "@/components/vesselIcon";
import {
  lineLatLngs,
  pointLatLng,
  polygonRings,
  toLatLng,
  toLatLngs,
  type GeoGeometry,
} from "@/components/webmap/geojson";
import {
  aircraftCourseVector,
  vesselCourseVector,
  AIRCRAFT_COURSE_COLOR,
  SHIP_COURSE_COLOR,
} from "@/components/webmap/course";
import {
  LOST_GEAR_COLOR,
  LOST_GEAR_GLYPH,
  lostGearDescription,
  lostGearTitle,
  zoneStyle,
} from "@/components/webmap/fishingStyle";
import {
  AIRPORT_COLOR,
  AIRPORT_GLYPH,
  RUNWAY_COLOR,
  airportFilter,
  airportGlyphSize,
  airportSubtitle,
  airportTitle,
} from "@/components/webmap/airportStyle";
import { MapViewToggle, type MapView as MapViewMode } from "@/components/webmap/MapViewToggle";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl, getHomeLocation } from "@/api/config";
import { DEMO_HOME } from "@/mock/mockFeed";

// Violet family — matches the satellite marker / detail sheet; distinct from the other map overlays.
const SAT_VIOLET = "#C792EA";

/**
 * One aircraft as a top-down airplane icon rotated to its track, laid flat on the map so the nose
 * points where it's heading (MaterialCommunityIcons "airplane" points north at rotation 0).
 * react-native-maps re-rasterises a custom marker view on every render, which would thrash at
 * 1 Hz x N aircraft — so we only let it track view changes briefly after mount (long enough to
 * capture the icon bitmap), then freeze it. Position (coordinate) and heading (rotation) still
 * update natively while frozen, so the marker keeps moving/turning without re-rasterising.
 */
function AircraftMarker({
  aircraft: a,
  onSelect,
}: {
  aircraft: AircraftDto;
  onSelect: (hex: string) => void;
}) {
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setTracksViewChanges(false), 800);
    return () => clearTimeout(t);
  }, []);
  return (
    <Marker
      coordinate={{ latitude: a.lat as number, longitude: a.lon as number }}
      title={a.flight?.trim() || a.hex.toUpperCase()}
      description={a.fl != null ? `FL${a.fl}` : undefined}
      onPress={() => onSelect(a.hex)}
      anchor={{ x: 0.5, y: 0.5 }}
      flat
      rotation={a.trk ?? 0}
      tracksViewChanges={tracksViewChanges}
    >
      <MaterialCommunityIcons name="airplane" size={24} color="#78C8FF" />
    </Marker>
  );
}

/**
 * One vessel as its class icon. Ships are rotated flat to their course-over-ground (heading as a
 * fallback) so the icon points where they're steaming; AtoNs are stationary and drawn upright. Same
 * tracksViewChanges freeze as AircraftMarker so 1 Hz × N ships don't re-rasterise. Tapping it opens
 * the vessel detail sheet (mirrors AircraftMarker).
 */
function VesselMarker({
  vessel: v,
  onSelect,
}: {
  vessel: VesselDto;
  onSelect: (mmsi: string) => void;
}) {
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setTracksViewChanges(false), 800);
    return () => clearTimeout(t);
  }, []);
  const { name, color } = iconForVessel(v);
  const isShip = v.kind === "ship";
  return (
    <Marker
      coordinate={{ latitude: v.lat as number, longitude: v.lon as number }}
      title={v.name?.trim() || v.mmsi}
      description={v.sog != null ? `${Math.round(v.sog)} kn` : undefined}
      onPress={() => onSelect(v.mmsi)}
      anchor={{ x: 0.5, y: 0.5 }}
      flat
      rotation={isShip ? (v.cog ?? v.hdg ?? 0) : 0}
      tracksViewChanges={tracksViewChanges}
    >
      <MaterialCommunityIcons name={name} size={22} color={color} />
    </Marker>
  );
}

/**
 * Fishing-regulation zones as translucent polygons (forbidden / zero) and polylines (cod boundaries).
 * A MultiPolygon renders as one <Polygon> per member. Drawn as context — react-native-maps polygons
 * have no callout primitive, so zones are non-interactive here (the web map exposes the `info` popup).
 */
function FishingZoneShapes({ zones }: { zones: FishingZone[] }) {
  return (
    <>
      {zones.map((z, i) => {
        const geom = z.geometry as GeoGeometry | null;
        const style = zoneStyle(z.kind);
        const polys = polygonRings(geom);
        if (polys.length > 0) {
          return polys.map((p, j) => (
            <Polygon
              key={`zone-poly-${i}-${j}`}
              coordinates={toLatLngs(p.outer)}
              holes={p.holes.map(toLatLngs)}
              strokeColor={style.stroke}
              strokeWidth={1.5}
              fillColor={style.fill}
            />
          ));
        }
        const line = lineLatLngs(geom);
        if (line.length > 0) {
          return (
            <Polyline
              key={`zone-line-${i}`}
              coordinates={toLatLngs(line)}
              strokeColor={style.stroke}
              strokeWidth={2}
            />
          );
        }
        return null;
      })}
    </>
  );
}

/** Lost-gear points as hazard-orange markers; the native callout shows gear type + lost date + cause. */
function LostGearMarkers({ gear }: { gear: LostGear[] }) {
  return (
    <>
      {gear.map((g, i) => {
        const pt = pointLatLng(g.geometry as GeoGeometry | null);
        if (!pt) return null;
        return (
          <Marker
            key={`gear-${i}`}
            coordinate={toLatLng(pt)}
            title={lostGearTitle(g)}
            description={lostGearDescription(g)}
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <MaterialCommunityIcons name={LOST_GEAR_GLYPH} size={20} color={LOST_GEAR_COLOR} />
          </Marker>
        );
      })}
    </>
  );
}

/**
 * One airport as its steel-blue MCI glyph, laid flat and upright (NOT rotated — it's a fixed reference,
 * not a moving target), sized by class. Same tracksViewChanges freeze as the traffic markers so 1 Hz
 * re-renders don't re-rasterise. Tapping it opens the airport detail sheet.
 */
function AirportMarker({
  airport: a,
  onSelect,
}: {
  airport: AirportDto;
  onSelect: (ident: string) => void;
}) {
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setTracksViewChanges(false), 800);
    return () => clearTimeout(t);
  }, []);
  return (
    <Marker
      coordinate={{ latitude: a.lat, longitude: a.lon }}
      title={airportTitle(a)}
      description={airportSubtitle(a)}
      onPress={() => onSelect(a.ident)}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracksViewChanges}
    >
      <MaterialCommunityIcons name={AIRPORT_GLYPH} size={airportGlyphSize(a.type)} color={AIRPORT_COLOR} />
    </Marker>
  );
}

/** Real runway segments per airport — one steel-blue Polyline per runway whose BOTH ends carry coords. */
function AirportRunways({ airports }: { airports: AirportDto[] }) {
  return (
    <>
      {airports.map((a) =>
        a.runways.map((r, j) =>
          r.leLat != null && r.leLon != null && r.heLat != null && r.heLon != null ? (
            <Polyline
              key={`rwy-${a.ident}-${j}`}
              coordinates={[
                { latitude: r.leLat, longitude: r.leLon },
                { latitude: r.heLat, longitude: r.heLon },
              ]}
              strokeColor={RUNWAY_COLOR}
              strokeWidth={3}
            />
          ) : null,
        ),
      )}
    </>
  );
}

export default function MapScreen() {
  const aircraft = useAircraftList();
  const vessels = useVesselList();
  const demoMode = useSettingsStore((s) => s.demoMode);
  const showShips = useSettingsStore((s) => s.showShips);
  const showAton = useSettingsStore((s) => s.showAton);
  const showCourseVectors = useSettingsStore((s) => s.showCourseVectors);
  const showAirports = useSettingsStore((s) => s.showAirports);
  const showSmallAirfields = useSettingsStore((s) => s.showSmallAirfields);
  const showFishingZones = useSettingsStore((s) => s.showFishingZones);
  const showLostGear = useSettingsStore((s) => s.showLostGear);
  const radarRangeKm = useSettingsStore((s) => s.radarRangeKm);
  const setRadarRangeKm = useSettingsStore((s) => s.setRadarRangeKm);
  const client = useMemo(() => new ApiClient({ baseUrl: getApiBaseUrl() }), []);
  // Ground track for the satellite (if any) selected from a detail sheet. Reads the ephemeral store.
  const track = useSatelliteGroundTrack(client);
  // Arriving from "Show ground track" (a track is set) opens the real Map, not the you-centric radar —
  // a globe-spanning track is meaningless there. Captured once at mount.
  const [view, setView] = useState<MapViewMode>(track.trackedNoradId != null ? "map" : "radar");
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [selectedMmsi, setSelectedMmsi] = useState<string | null>(null);
  const [selectedAirportIdent, setSelectedAirportIdent] = useState<string | null>(null);
  const mapRef = useRef<MapView>(null);
  const fittedFor = useRef<number | null>(null);
  // Fishing overlays fetch only when at least one toggle is on; fail-soft to empty when unconfigured.
  const { zones, gear } = useFishingLayers({
    client,
    enabled: showFishingZones || showLostGear,
  });

  // Snap to the map view whenever a track is (re)selected — a track only renders there, and expo-router
  // keeps this tab mounted across a re-navigation from the sheet, so the mount-time default alone can't
  // catch a selection made while the tab already sits on radar. Guard runs via a named function to stay
  // clear of the set-state-in-effect rule (same discipline as useSatellites' tick()).
  useEffect(() => {
    const snapToMap = () => setView("map");
    if (track.trackedNoradId != null) snapToMap();
  }, [track.trackedNoradId]);

  // Fit the map to the track bounds once per new tracked satellite (so it zooms out to the whole orbit).
  // Keyed on the tracked id, not every render; points arrive a moment after selection (async fetch).
  useEffect(() => {
    if (view !== "map" || track.trackedNoradId == null) {
      if (track.trackedNoradId == null) fittedFor.current = null;
      return;
    }
    if (fittedFor.current === track.trackedNoradId) return;
    const coords = track.segments.flat().map((p) => ({ latitude: p.lat, longitude: p.lon }));
    if (coords.length === 0) return;
    mapRef.current?.fitToCoordinates(coords, {
      edgePadding: { top: 60, right: 60, bottom: 60, left: 60 },
      animated: true,
    });
    fittedFor.current = track.trackedNoradId;
  }, [view, track.trackedNoradId, track.segments]);
  const observer = useMemo(
    () => (demoMode ? DEMO_HOME : (getHomeLocation() ?? DEMO_HOME)),
    [demoMode],
  );
  const positioned = aircraft.filter((a) => a.lat != null && a.lon != null);
  // Vessels the toggles allow, positioned only — ships gated by showShips, AtoNs by showAton.
  const positionedVessels = vessels.filter(
    (v) => v.lat != null && v.lon != null && (v.kind === "aton" ? showAton : showShips),
  );
  // Airports: fetched once (static) when the layer is on, then filtered by the small-airfields toggle.
  const airports = useAirports({ client, observer, enabled: showAirports });
  const shownAirports = useMemo(
    () => airports.filter((a) => airportFilter(a.type, showSmallAirfields)),
    [airports, showSmallAirfields],
  );

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <MapViewToggle view={view} onChange={setView} count={positioned.length} />
      <View style={styles.body}>
        {view === "radar" ? (
          <AircraftRadar
            aircraft={positioned}
            vessels={positionedVessels}
            airports={shownAirports}
            observer={observer}
            onSelect={setSelectedHex}
            onSelectVessel={setSelectedMmsi}
            onSelectAirport={setSelectedAirportIdent}
            rangeKm={radarRangeKm}
            onRangeChange={setRadarRangeKm}
            showCourseVectors={showCourseVectors}
          />
        ) : (
          <MapView
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            initialRegion={{ latitude: observer.lat, longitude: observer.lon, latitudeDelta: 1.2, longitudeDelta: 1.2 }}
            showsUserLocation
          >
            {/* Fishing overlays first so aircraft/vessel markers draw on top of the zone fills. */}
            {showFishingZones ? <FishingZoneShapes zones={zones} /> : null}
            {showLostGear ? <LostGearMarkers gear={gear} /> : null}
            {/* Airports: runway segments drawn just before the (upright, class-sized) airport markers,
                both under the traffic markers so aircraft/vessels stay on top. */}
            {showAirports ? <AirportRunways airports={shownAirports} /> : null}
            {showAirports
              ? shownAirports.map((a) => (
                  <AirportMarker key={a.ident} airport={a} onSelect={setSelectedAirportIdent} />
                ))
              : null}
            {/* Course leaders: dashed, under the solid violet track and the markers. */}
            {showCourseVectors &&
              positioned.map((a) => {
                const v = aircraftCourseVector(a);
                return v ? (
                  <Polyline
                    key={`ac-course-${a.hex}`}
                    coordinates={toLatLngs(v)}
                    strokeColor={AIRCRAFT_COURSE_COLOR}
                    strokeWidth={2}
                    lineDashPattern={[6, 4]}
                  />
                ) : null;
              })}
            {showCourseVectors &&
              positionedVessels.map((ves) => {
                const v = vesselCourseVector(ves);
                return v ? (
                  <Polyline
                    key={`ship-course-${ves.mmsi}`}
                    coordinates={toLatLngs(v)}
                    strokeColor={SHIP_COURSE_COLOR}
                    strokeWidth={2}
                    lineDashPattern={[6, 4]}
                  />
                ) : null;
              })}
            {/* Satellite ground track: one violet polyline per antimeridian-split segment. */}
            {track.segments.map((seg, i) => (
              <Polyline
                key={`sat-track-${i}`}
                coordinates={toLatLngs(seg.map((p) => [p.lat, p.lon]))}
                strokeColor={SAT_VIOLET}
                strokeWidth={2.5}
              />
            ))}
            <Marker
              coordinate={{ latitude: observer.lat, longitude: observer.lon }}
              title="You"
              pinColor="#78C8FF"
            />
            {positioned.map((a) => (
              <AircraftMarker key={a.hex} aircraft={a} onSelect={setSelectedHex} />
            ))}
            {positionedVessels.map((v) => (
              <VesselMarker key={v.mmsi} vessel={v} onSelect={setSelectedMmsi} />
            ))}
            {/* Current sub-satellite point; tapping it also clears the track. */}
            {track.subPoint ? (
              <Marker
                coordinate={toLatLng([track.subPoint.lat, track.subPoint.lon])}
                title={track.name ?? "Satellite"}
                onPress={track.clear}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <MaterialCommunityIcons name="satellite-variant" size={24} color={SAT_VIOLET} />
              </Marker>
            ) : null}
          </MapView>
        )}
        {view === "map" && track.trackedNoradId != null ? (
          <Pressable testID="clear-track" style={styles.clearTrack} onPress={track.clear}>
            <Text style={styles.clearTrackText}>✕ Clear track</Text>
          </Pressable>
        ) : null}
      </View>
      <DetailSheet hex={selectedHex} client={client} onClose={() => setSelectedHex(null)} />
      <VesselDetailSheet
        mmsi={selectedMmsi}
        vessel={selectedMmsi != null ? vessels.find((v) => v.mmsi === selectedMmsi) : undefined}
        onClose={() => setSelectedMmsi(null)}
      />
      <AirportDetailSheet
        ident={selectedAirportIdent}
        airport={
          selectedAirportIdent != null
            ? airports.find((a) => a.ident === selectedAirportIdent)
            : undefined
        }
        onClose={() => setSelectedAirportIdent(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B1622" },
  body: { flex: 1 },
  clearTrack: {
    position: "absolute",
    top: 12,
    right: 12,
    backgroundColor: "rgba(11, 22, 34, 0.9)",
    borderColor: SAT_VIOLET,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  clearTrackText: { color: SAT_VIOLET, fontSize: 13, fontWeight: "700" },
});
