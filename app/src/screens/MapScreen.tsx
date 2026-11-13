/**
 * Native Map view: two spatial renderings, switchable — the real react-native-maps MapView (the
 * default when it can draw, see useMapViewMode) and Radar (you-centric, offline). Reads the same
 * 1 Hz store; tapping a marker/blip opens the detail sheet.
 * Web has no react-native-maps — see MapScreen.web.tsx (Leaflet). The flat list lives in the List tab.
 */

import { alpha, color } from "@/theme";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MapView, { Marker, Polygon, Polyline } from "react-native-maps";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { AircraftDto, AirportDto, FishingZone, LostGear, PortDto, VesselDto } from "@/api/types";
import { PORT_COLOR, PORT_GLYPH, portGlyphSize, portSubtitle, portTitle } from "@/components/webmap/portStyle";
import { useAircraftList } from "@/state/aircraftStore";
import { useVesselList } from "@/state/vesselStore";
import { useSettingsStore } from "@/state/settingsStore";
import { useMapFocusStore } from "@/state/mapFocusStore";
import {
  DetailSheet,
  AircraftRadar,
  AirportDetailSheet,
  SatelliteDetailSheet,
  VesselDetailSheet,
  useAirports,
  useFishingLayers,
  useOverheadSatellites,
  usePorts,
  useSatelliteGroundTrack,
} from "@/components";
import { iconForVessel } from "@/components/vesselIcon";
import { aircraftAccent } from "@/components/aircraftIcon";
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
import {
  footprintSatellite,
  mapSatellites,
  satelliteFootprint,
  showTrackedMarker,
  type MapSatellite,
} from "@/components/webmap/satelliteLayer";
import type { Footprint } from "@/ar";
import { MapViewToggle } from "@/components/webmap/MapViewToggle";
import type { MapView as MapViewMode } from "@/components/webmap/mapView";
import { useMapViewMode } from "@/components/webmap/useMapViewMode";
import { FOCUS_SPAN_DEG, resolveFocus } from "@/components/webmap/focus";
import { MapFocusChip } from "@/components/webmap/MapFocusChip";
import { ApiClient } from "@/api/client";
import { getApiBaseUrl } from "@/api/config";
import { useObserver } from "@/components/useObserver";
import { useDetailSelection } from "@/components/useDetailSelection";
import { useSheetRightInset } from "@/components/Sheet";

/**
 * One aircraft as a top-down airplane icon rotated to its track, laid flat on the map so the nose
 * points where it's heading (MaterialCommunityIcons "airplane" points north at rotation 0).
 * react-native-maps re-rasterises a custom marker view on every render, which would thrash at
 * 1 Hz x N aircraft — so we only let it track view changes briefly after mount (long enough to
 * capture the icon bitmap), then freeze it. Position (coordinate) and heading (rotation) still
 * update natively while frozen, so the marker keeps moving/turning without re-rasterising. Same
 * testID as the radar blip (only one of the two views is mounted at a time).
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
      testID={`map-ac-${a.hex}`}
      coordinate={{ latitude: a.lat as number, longitude: a.lon as number }}
      title={a.flight?.trim() || a.hex.toUpperCase()}
      description={a.fl != null ? `FL${a.fl}` : undefined}
      onPress={() => onSelect(a.hex)}
      anchor={{ x: 0.5, y: 0.5 }}
      flat
      rotation={a.trk ?? 0}
      tracksViewChanges={tracksViewChanges}
    >
      <MaterialCommunityIcons name="airplane" size={24} color={aircraftAccent(a)} />
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
      testID={`map-ship-${v.mmsi}`}
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
 * One overhead satellite at its sub-satellite point, as the violet satellite glyph (upright: a
 * sub-point has no meaningful "heading" on the map). Same brief tracksViewChanges window as the
 * traffic markers, so the 1 Hz position updates move the frozen bitmap natively instead of
 * re-rasterising it. No permanent name label (it would bloat every bitmap and pile up when zoomed
 * out); the name is the marker title / accessibility label. Tapping opens the satellite card.
 */
function SatelliteMarker({
  sat,
  onSelect,
}: {
  sat: MapSatellite;
  onSelect: (noradId: number) => void;
}) {
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setTracksViewChanges(false), 800);
    return () => clearTimeout(t);
  }, []);
  return (
    <Marker
      testID={`map-sat-${sat.noradId}`}
      coordinate={{ latitude: sat.lat, longitude: sat.lon }}
      title={sat.name}
      accessibilityLabel={`Satellite ${sat.name}`}
      onPress={() => onSelect(sat.noradId)}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracksViewChanges}
    >
      <MaterialCommunityIcons name="satellite-variant" size={22} color={color.entity.orbit} />
    </Marker>
  );
}

/**
 * Coverage footprint of the one selected satellite: a very light orbit-coloured fill (no stroke, so
 * the antimeridian / pole-cap clip edges stay invisible) under a thin outline of the circle itself.
 */
function SatelliteFootprintShapes({ fp }: { fp: Footprint }) {
  return (
    <>
      {fp.polygons.map((ring, i) => (
        <Polygon
          key={`sat-fp-fill-${i}`}
          testID="map-sat-footprint"
          coordinates={toLatLngs(ring)}
          strokeWidth={0}
          strokeColor="transparent"
          fillColor={alpha(color.entity.orbit, 0.08)}
          tappable={false}
        />
      ))}
      {fp.outline.map((line, i) => (
        <Polyline
          key={`sat-fp-line-${i}`}
          coordinates={toLatLngs(line)}
          strokeColor={alpha(color.entity.orbit, 0.7)}
          strokeWidth={1}
        />
      ))}
    </>
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

/**
 * One port / harbour / marina / ferry quay as its kind glyph in the muted port colour, upright. Same
 * brief tracksViewChanges window as the airport markers; the callout shows name + kind + source.
 */
function PortMarker({ port: p }: { port: PortDto }) {
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setTracksViewChanges(false), 800);
    return () => clearTimeout(t);
  }, []);
  return (
    <Marker
      coordinate={{ latitude: p.lat, longitude: p.lon }}
      title={portTitle(p)}
      description={portSubtitle(p)}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracksViewChanges}
    >
      <MaterialCommunityIcons name={PORT_GLYPH[p.kind]} size={portGlyphSize(p.kind)} color={PORT_COLOR} />
    </Marker>
  );
}

/**
 * Ring drawn under the focused aircraft/vessel ("Show on map"). A static view, so it uses the same
 * brief tracksViewChanges window as the traffic markers and then only moves natively.
 */
function FocusRing({ lat, lon, accent }: { lat: number; lon: number; accent: string }) {
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setTracksViewChanges(false), 800);
    return () => clearTimeout(t);
  }, []);
  return (
    <Marker
      coordinate={{ latitude: lat, longitude: lon }}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracksViewChanges}
      tappable={false}
    >
      <View style={[styles.focusRing, { borderColor: accent, backgroundColor: alpha(accent, 0.15) }]} />
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
  // Map by default (Radar when this build can't draw it); snaps to the Map for a track or a "Show on
  // map" request. See useMapViewMode.
  const { view, setView } = useMapViewMode(track.trackedNoradId);
  // One selection slot for the detail cards: they are non-modal, so tapping another marker (of any
  // kind) swaps the open card instead of stacking a second one.
  const detail = useDetailSelection();
  const selectedHex = detail.idOf("aircraft");
  const selectedMmsi = detail.idOf("vessel");
  const selectedAirportIdent = detail.idOf("airport");
  const selectedSat = detail.idOf("satellite");
  const selectedNoradId = selectedSat != null ? Number(selectedSat) : null;
  const {
    aircraft: setSelectedHex,
    vessel: setSelectedMmsi,
    airport: setSelectedAirportIdent,
    satellite: setSelectedSat,
  } = detail.set;
  const selectSatellite = useCallback((id: number) => setSelectedSat(String(id)), [setSelectedSat]);
  // While a side-panel card is open (wide screens), right-edge controls move left by its width.
  const cardRightInset = useSheetRightInset(detail.open);
  const mapRef = useRef<MapView>(null);
  const fittedFor = useRef<number | null>(null);
  // "Show on map" focus from a detail sheet: centre once per request (seq), then follow until the
  // user drags the map. The map can only be animated after onMapReady, and a radar/map switch
  // remounts it, so both reset the ready flag and the "already centred" marker.
  const focus = useMapFocusStore((s) => s.focus);
  const focusSeq = useMapFocusStore((s) => s.seq);
  const following = useMapFocusStore((s) => s.following);
  const setFocus = useMapFocusStore((s) => s.setFocus);
  const setFollowing = useMapFocusStore((s) => s.setFollowing);
  const clearFocus = useMapFocusStore((s) => s.clear);
  const [mapReady, setMapReady] = useState(false);
  const centredSeq = useRef<number | null>(null);
  const changeView = (next: MapViewMode) => {
    if (next !== view) {
      setMapReady(false);
      centredSeq.current = null;
    }
    setView(next);
  };
  // Fishing overlays fetch only when at least one toggle is on; fail-soft to empty when unconfigured.
  const { zones, gear } = useFishingLayers({
    client,
    enabled: showFishingZones || showLostGear,
  });

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
  // Device GPS (or baked home) shared via observerStore, not the build-time home alone.
  const observer = useObserver();
  const positioned = aircraft.filter((a) => a.lat != null && a.lon != null);
  // Vessels the toggles allow, positioned only — ships gated by showShips, AtoNs by showAton.
  const positionedVessels = vessels.filter(
    (v) => v.lat != null && v.lon != null && (v.kind === "aton" ? showAton : showShips),
  );
  const target = useMemo(() => resolveFocus(focus, aircraft, vessels), [focus, aircraft, vessels]);
  const targetLat = target?.position?.lat;
  const targetLon = target?.position?.lon;
  const targetKind = target?.kind;

  // Follow: keep the target centred as it moves (zoom untouched). Declared BEFORE the centre effect
  // so the render that centres doesn't immediately interrupt that animation with a pan.
  useEffect(() => {
    if (view !== "map" || !mapReady || !following || targetLat == null || targetLon == null) return;
    if (centredSeq.current !== focusSeq) return;
    mapRef.current?.animateCamera({ center: { latitude: targetLat, longitude: targetLon } }, { duration: 900 });
  }, [view, mapReady, following, focusSeq, targetLat, targetLon]);

  // Centre + zoom once per request.
  useEffect(() => {
    if (view !== "map" || !mapReady || targetKind == null || targetLat == null || targetLon == null) return;
    if (centredSeq.current === focusSeq) return;
    const span = FOCUS_SPAN_DEG[targetKind];
    mapRef.current?.animateToRegion(
      { latitude: targetLat, longitude: targetLon, latitudeDelta: span, longitudeDelta: span },
      600,
    );
    centredSeq.current = focusSeq;
  }, [view, mapReady, focusSeq, targetKind, targetLat, targetLon]);
  // Airports: fetched once (static) when the layer is on, then filtered by the small-airfields toggle.
  const airports = useAirports({ client, observer, enabled: showAirports });
  const shownAirports = useMemo(
    () => airports.filter((a) => airportFilter(a.type, showSmallAirfields)),
    [airports, showSmallAirfields],
  );
  // Satellites layer: exactly the List's Overhead set (same hook), each at its sub-satellite point,
  // re-placed at the hook's 1 Hz tick. One footprint, for the open card's satellite (else the tracked one).
  const showMapSatellites = useSettingsStore((s) => s.showMapSatellites);
  const sats = useOverheadSatellites({ client, observer, enabled: showMapSatellites });
  const satMarkers = useMemo(() => mapSatellites(sats.overhead, showMapSatellites), [sats.overhead, showMapSatellites]);
  const satFootprint = useMemo(
    () =>
      view === "map" && showMapSatellites
        ? satelliteFootprint(footprintSatellite(selectedNoradId, track.trackedNoradId, sats.byNoradId))
        : null,
    [view, showMapSatellites, selectedNoradId, track.trackedNoradId, sats.byNoradId],
  );
  // Ports: static reference markers like the airports (map view only).
  const showPorts = useSettingsStore((s) => s.showPorts);
  const { ports, attribution: portsAttribution } = usePorts({ client, observer, enabled: showPorts });

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <MapViewToggle view={view} onChange={changeView} count={positioned.length} />
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
            controlsRightInset={cardRightInset}
          />
        ) : (
          <MapView
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            initialRegion={{ latitude: observer.lat, longitude: observer.lon, latitudeDelta: 1.2, longitudeDelta: 1.2 }}
            showsUserLocation
            // Keeps Google's own controls (my-location button, logo) clear of a side-panel card.
            mapPadding={{ top: 0, left: 0, bottom: 0, right: cardRightInset }}
            onMapReady={() => setMapReady(true)}
            // A user drag ends follow mode; the focus chip resumes it.
            onPanDrag={() => {
              if (following) setFollowing(false);
            }}
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
            {ports.map((p) => (
              <PortMarker key={p.id} port={p} />
            ))}
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
                strokeColor={color.entity.orbit}
                strokeWidth={2.5}
              />
            ))}
            {/* Selected satellite's coverage footprint: under the markers, faint. */}
            {satFootprint ? <SatelliteFootprintShapes fp={satFootprint} /> : null}
            <Marker
              coordinate={{ latitude: observer.lat, longitude: observer.lon }}
              title="You"
              pinColor={color.entity.air}
            />
            {target?.position ? (
              <FocusRing
                key={`focus-${target.kind}-${target.id}`}
                lat={target.position.lat}
                lon={target.position.lon}
                accent={target.kind === "aircraft" ? color.entity.air : color.entity.sea}
              />
            ) : null}
            {positioned.map((a) => (
              <AircraftMarker key={a.hex} aircraft={a} onSelect={setSelectedHex} />
            ))}
            {positionedVessels.map((v) => (
              <VesselMarker key={v.mmsi} vessel={v} onSelect={setSelectedMmsi} />
            ))}
            {satMarkers.map((sat) => (
              <SatelliteMarker key={`sat-${sat.noradId}`} sat={sat} onSelect={selectSatellite} />
            ))}
            {/* Tracked satellite's sub-point (tapping it clears the track) — only when the satellites
                layer isn't already drawing that satellite. */}
            {track.subPoint && showTrackedMarker(track.trackedNoradId, satMarkers) ? (
              <Marker
                testID="map-sat-track-point"
                coordinate={toLatLng([track.subPoint.lat, track.subPoint.lon])}
                title={track.name ?? "Satellite"}
                onPress={track.clear}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <MaterialCommunityIcons name="satellite-variant" size={24} color={color.entity.orbit} />
              </Marker>
            ) : null}
          </MapView>
        )}
        {/* The Google base map doesn't credit OpenStreetMap, so the OSM-derived ports carry their own
            ODbL attribution while they're shown. */}
        {view === "map" && ports.length > 0 && portsAttribution ? (
          <Text style={styles.portsAttribution} pointerEvents="none">
            Ports {portsAttribution}
          </Text>
        ) : null}
        {view === "map" && track.trackedNoradId != null ? (
          <Pressable
            testID="clear-track"
            style={[styles.clearTrack, { right: 12 + cardRightInset }]}
            onPress={track.clear}
          >
            <Text style={styles.clearTrackText}>✕ Clear track</Text>
          </Pressable>
        ) : null}
        {view === "map" && target && focus ? (
          <MapFocusChip
            target={target}
            following={following}
            onFollow={() => setFocus(focus)}
            onClear={clearFocus}
          />
        ) : null}
        {/* Detail card last, over the map; mounted in the body so the side panel starts below the
            view toggle. */}
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
        <SatelliteDetailSheet
          noradId={selectedNoradId}
          view={selectedNoradId != null ? sats.byNoradId.get(selectedNoradId) : undefined}
          observer={observer}
          elevationMaskDeg={sats.elevationMaskDeg}
          onClose={() => setSelectedSat(null)}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  portsAttribution: {
    position: "absolute",
    left: 8,
    bottom: 4,
    fontSize: 10,
    color: color.textDim,
    backgroundColor: alpha(color.bg, 0.7),
    paddingHorizontal: 4,
    borderRadius: 3,
  },
  body: { flex: 1 },
  clearTrack: {
    position: "absolute",
    top: 12,
    right: 12,
    backgroundColor: alpha(color.bg, 0.9),
    borderColor: color.entity.orbit,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  clearTrackText: { color: color.entity.orbit, fontSize: 13, fontWeight: "700" },
  focusRing: { width: 40, height: 40, borderRadius: 20, borderWidth: 2 },
});
