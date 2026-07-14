/**
 * Real geographic map for the web Map view: OpenStreetMap tiles with a heading-rotated marker per
 * aircraft and a marker for the observer. Web-only — imported solely from map.web.tsx, so leaflet
 * (which needs the DOM) never reaches the native bundle. Native's Map uses react-native-maps.
 */

import { color } from "@/theme";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import { MapContainer, Marker, Polygon, Polyline, Popup, TileLayer, useMap } from "react-leaflet";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { AircraftDto, AirportDto, FishingZone, LostGear, VesselDto } from "@/api/types";
import { iconForCategory } from "@/components/aircraftIcon";
import { iconForVessel } from "@/components/vesselIcon";
import { lineLatLngs, pointLatLng, polygonRings, type GeoGeometry, type LatLngTuple } from "./geojson";
import {
  AIRPORT_COLOR,
  AIRPORT_GLYPH,
  RUNWAY_COLOR,
  airportGlyphSize,
  airportSubtitle,
  airportTitle,
} from "./airportStyle";
import {
  aircraftCourseVector,
  vesselCourseVector,
  AIRCRAFT_COURSE_COLOR,
  SHIP_COURSE_COLOR,
} from "./course";
import {
  LOST_GEAR_COLOR,
  LOST_GEAR_GLYPH,
  lostGearDescription,
  lostGearTitle,
  zoneInfo,
  zoneStyle,
} from "./fishingStyle";
import type { Observer } from "./relative";

export interface LeafletMapProps {
  aircraft: AircraftDto[];
  observer: Observer;
  onSelect: (hex: string) => void;
  /** AIS vessels to plot alongside aircraft; already filtered to the visible kinds by the caller. */
  vessels?: VesselDto[];
  /** Tap handler for a vessel marker (opens the vessel detail sheet). Markers are inert when omitted. */
  onSelectVessel?: (mmsi: string) => void;
  /** Fishing-regulation zones to draw under the traffic; already gated by the caller (empty = nothing). */
  zones?: FishingZone[];
  /** Lost/ghost fishing-gear points to draw; already gated by the caller (empty = nothing). */
  gear?: LostGear[];
  /** Airports to plot as reference markers + runway segments; already filtered by the caller. */
  airports?: AirportDto[];
  /** Tap handler for an airport marker (opens the airport detail sheet). Markers inert when omitted. */
  onSelectAirport?: (ident: string) => void;
  /** Satellite ground-track segments ([lat,lng] tuples, antimeridian-split); empty = no track drawn. */
  trackSegments?: LatLngTuple[][];
  /** Current sub-satellite point ([lat,lng]) for the live marker, or null when no track is shown. */
  trackSubPoint?: LatLngTuple | null;
  /** Name of the tracked satellite (marker popup). */
  trackName?: string | null;
  /** NORAD id of the tracked satellite — the fit-to-track key (auto-fit fires once per new id). */
  trackKey?: number | null;
  /** Clear the current track (clear chip + tapping the sub-point marker). */
  onClearTrack?: () => void;
  /** Draw a short predicted-track (course/heading) leader ahead of moving aircraft & ships. */
  showCourseVectors?: boolean;
}

// Reach the icon-font statics (not in the public types) so Leaflet's raw-HTML markers render the same
// MaterialCommunityIcons glyphs the radar/list use, instead of a generic shape.
const iconFont = (MaterialCommunityIcons as unknown as { getFontFamily(): string }).getFontFamily();
const glyphMap = (MaterialCommunityIcons as unknown as { getRawGlyphMap(): Record<string, number> }).getRawGlyphMap();

/** Marker showing the aircraft's type icon (plane / helicopter / balloon / …). */
function aircraftIcon(cat: string | null | undefined): L.DivIcon {
  const code = glyphMap[iconForCategory(cat)];
  const glyph = code != null ? String.fromCodePoint(code) : "";
  return L.divIcon({
    className: "",
    html: `<span style="font-family:'${iconFont}';font-size:20px;line-height:20px;color:#78C8FF;text-shadow:0 0 3px #000">${glyph}</span>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

/**
 * Marker for a vessel: its class glyph in the maritime colour iconForVessel picks. Ships are
 * rotated to course-over-ground (heading fallback); AtoNs stay upright. Same raw-HTML divIcon path
 * as the aircraft marker so both render from the MCI icon font.
 */
function vesselMarkerIcon(v: VesselDto): L.DivIcon {
  const { name, color } = iconForVessel(v);
  const code = glyphMap[name];
  const glyph = code != null ? String.fromCodePoint(code) : "";
  const rot = v.kind === "ship" ? (v.cog ?? v.hdg ?? 0) : 0;
  return L.divIcon({
    className: "",
    html: `<span style="font-family:'${iconFont}';font-size:20px;line-height:20px;color:${color};text-shadow:0 0 3px #000;display:inline-block;transform:rotate(${rot}deg)">${glyph}</span>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

/** Airport marker: the MCI "airport" glyph in steel-blue, class-sized (same divIcon path as traffic). */
function airportIcon(type: string): L.DivIcon {
  const code = glyphMap[AIRPORT_GLYPH];
  const glyph = code != null ? String.fromCodePoint(code) : "";
  const size = airportGlyphSize(type);
  return L.divIcon({
    className: "",
    html: `<span style="font-family:'${iconFont}';font-size:${size}px;line-height:${size}px;color:${AIRPORT_COLOR};text-shadow:0 0 3px #000">${glyph}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

const observerIcon = L.divIcon({
  className: "",
  html: `<div style="width:12px;height:12px;border-radius:6px;background:#7CFC9A;border:2px solid #0B1622;box-shadow:0 0 4px #000"></div>`,
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

// Violet sub-satellite marker: the same MCI-font divIcon path as the traffic markers.
const satelliteIcon: L.DivIcon = (() => {
  const code = glyphMap["satellite-variant"];
  const glyph = code != null ? String.fromCodePoint(code) : "";
  return L.divIcon({
    className: "",
    html: `<span style="font-family:'${iconFont}';font-size:22px;line-height:22px;color:${color.entity.orbit};text-shadow:0 0 3px #000">${glyph}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
})();

// Lost/ghost-gear marker: the same MCI-font divIcon path as the traffic markers, in hazard orange.
const lostGearIcon: L.DivIcon = (() => {
  const code = glyphMap[LOST_GEAR_GLYPH];
  const glyph = code != null ? String.fromCodePoint(code) : "";
  return L.divIcon({
    className: "",
    html: `<span style="font-family:'${iconFont}';font-size:18px;line-height:18px;color:${LOST_GEAR_COLOR};text-shadow:0 0 3px #000">${glyph}</span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
})();

/**
 * Fishing-regulation zones as translucent polygons (forbidden / zero) and lines (cod boundaries). Each
 * carries a click Popup with the upstream `info` text when present. Rendered in Leaflet's overlay pane,
 * so it always sits under the marker pane (traffic stays on top). Gated to nothing by an empty `zones`.
 */
function FishingZones({ zones }: { zones: FishingZone[] }) {
  return (
    <>
      {zones.map((z, i) => {
        const geom = z.geometry as GeoGeometry | null;
        const style = zoneStyle(z.kind);
        const info = zoneInfo(z);
        const polys = polygonRings(geom);
        if (polys.length > 0) {
          // Leaflet Polygon positions take [outer, ...holes] rings; one <Polygon> per member polygon.
          return polys.map((p, j) => (
            <Polygon
              key={`zone-poly-${i}-${j}`}
              positions={[p.outer, ...p.holes]}
              pathOptions={{
                color: style.stroke,
                weight: 1.5,
                fillColor: style.stroke,
                fillOpacity: style.fillOpacity,
              }}
            >
              {info ? <Popup>{info}</Popup> : null}
            </Polygon>
          ));
        }
        const line = lineLatLngs(geom);
        if (line.length > 0) {
          return (
            <Polyline key={`zone-line-${i}`} positions={line} pathOptions={{ color: style.stroke, weight: 2 }}>
              {info ? <Popup>{info}</Popup> : null}
            </Polyline>
          );
        }
        return null;
      })}
    </>
  );
}

/** Lost-gear points as hazard-orange markers; a Popup shows gear type + lost date + cause on click. */
function LostGearMarkers({ gear }: { gear: LostGear[] }) {
  return (
    <>
      {gear.map((g, i) => {
        const pt = pointLatLng(g.geometry as GeoGeometry | null);
        if (!pt) return null;
        const description = lostGearDescription(g);
        return (
          <Marker key={`gear-${i}`} position={pt} icon={lostGearIcon} title={lostGearTitle(g)}>
            <Popup>
              {lostGearTitle(g)}
              {description ? <><br />{description}</> : null}
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}

/**
 * Airport reference layer: real runway segments (drawn only when BOTH ends carry coordinates) under
 * steel-blue, class-sized markers. A click opens the airport detail sheet; a Popup names it on hover.
 * Drawn under the traffic markers so aircraft/vessels stay on top and tappable.
 */
function Airports({
  airports,
  onSelectAirport,
}: {
  airports: AirportDto[];
  onSelectAirport?: (ident: string) => void;
}) {
  return (
    <>
      {airports.map((a) =>
        a.runways.map((r, j) =>
          r.leLat != null && r.leLon != null && r.heLat != null && r.heLon != null ? (
            <Polyline
              key={`rwy-${a.ident}-${j}`}
              positions={[
                [r.leLat, r.leLon],
                [r.heLat, r.heLon],
              ]}
              pathOptions={{ color: RUNWAY_COLOR, weight: 3 }}
            />
          ) : null,
        ),
      )}
      {airports.map((a) => {
        const subtitle = airportSubtitle(a);
        return (
          <Marker
            key={`apt-${a.ident}`}
            position={[a.lat, a.lon]}
            icon={airportIcon(a.type)}
            title={airportTitle(a)}
            eventHandlers={{ click: () => onSelectAirport?.(a.ident) }}
          >
            <Popup>
              {airportTitle(a)}
              {subtitle ? (
                <>
                  <br />
                  {subtitle}
                </>
              ) : null}
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}

/** Frame the initial view to fit the observer + traffic once, then leave panning to the user. */
function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || points.length === 0) return;
    map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 11 });
    done.current = true;
  }, [map, points]);
  return null;
}

/**
 * Zoom the map out to the ground-track bounds when a track is first set (so a globe-spanning orbit is
 * visible), keyed on the tracked NORAD id — it re-fits once per NEW satellite, not on every recompute
 * or unrelated re-render (mirrors FitBounds' done-ref, but re-arms when the id changes). Points arrive
 * a moment after selection (async fetch), so the fit fires on the first non-empty render for that id.
 */
function FitTrack({ points, trackKey }: { points: [number, number][]; trackKey: number | null }) {
  const map = useMap();
  const fittedFor = useRef<number | null>(null);
  useEffect(() => {
    if (trackKey == null || points.length === 0) return;
    if (fittedFor.current === trackKey) return;
    map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
    fittedFor.current = trackKey;
  }, [map, points, trackKey]);
  return null;
}

export function LeafletMap({
  aircraft,
  observer,
  onSelect,
  vessels = [],
  onSelectVessel,
  zones = [],
  gear = [],
  airports = [],
  onSelectAirport,
  trackSegments = [],
  trackSubPoint = null,
  trackName = null,
  trackKey = null,
  onClearTrack,
  showCourseVectors = false,
}: LeafletMapProps) {
  const positioned = aircraft.filter((a) => a.lat != null && a.lon != null);
  const positionedVessels = vessels.filter((v) => v.lat != null && v.lon != null);
  const points = useMemo<[number, number][]>(
    () => [
      [observer.lat, observer.lon],
      ...positioned.map((a) => [a.lat as number, a.lon as number] as [number, number]),
    ],
    [observer, positioned],
  );
  // All track vertices flattened, for the fit-to-track bounds.
  const trackPoints = useMemo<[number, number][]>(() => trackSegments.flat(), [trackSegments]);

  return (
    <MapContainer center={[observer.lat, observer.lon]} zoom={9} style={{ height: "100%", width: "100%" }} preferCanvas>
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        maxZoom={19}
      />
      {/* Fishing overlays render first (overlay pane) so aircraft/vessel markers stay on top. */}
      <FishingZones zones={zones} />
      <LostGearMarkers gear={gear} />
      {/* Airport reference layer under the traffic markers (runways + steel-blue class-sized markers). */}
      <Airports airports={airports} onSelectAirport={onSelectAirport} />
      <Marker position={[observer.lat, observer.lon]} icon={observerIcon} />
      {positioned.map((a) => (
        <Marker
          key={a.hex}
          position={[a.lat as number, a.lon as number]}
          icon={aircraftIcon(a.cat)}
          eventHandlers={{ click: () => onSelect(a.hex) }}
        />
      ))}
      {/* Vessels: tappable → the vessel detail sheet; a title gives the name/mmsi on hover. */}
      {positionedVessels.map((v) => (
        <Marker
          key={v.mmsi}
          position={[v.lat as number, v.lon as number]}
          icon={vesselMarkerIcon(v)}
          title={v.name?.trim() || v.mmsi}
          eventHandlers={{ click: () => onSelectVessel?.(v.mmsi) }}
        />
      ))}
      {/* Course leaders: dashed, drawn before the solid violet track so the track stays on top. */}
      {showCourseVectors &&
        positioned.map((a) => {
          const v = aircraftCourseVector(a);
          return v ? (
            <Polyline
              key={`ac-course-${a.hex}`}
              positions={v}
              pathOptions={{ color: AIRCRAFT_COURSE_COLOR, weight: 2, opacity: 0.8, dashArray: "6 4" }}
            />
          ) : null;
        })}
      {showCourseVectors &&
        positionedVessels.map((ves) => {
          const v = vesselCourseVector(ves);
          return v ? (
            <Polyline
              key={`ship-course-${ves.mmsi}`}
              positions={v}
              pathOptions={{ color: SHIP_COURSE_COLOR, weight: 2, opacity: 0.8, dashArray: "6 4" }}
            />
          ) : null;
        })}
      {/* Satellite ground track: one violet polyline per antimeridian-split segment, over the traffic. */}
      {trackSegments.map((seg, i) => (
        <Polyline
          key={`sat-track-${i}`}
          positions={seg}
          pathOptions={{ color: color.entity.orbit, weight: 2.5, opacity: 0.9 }}
        />
      ))}
      {trackSubPoint ? (
        <Marker
          position={trackSubPoint}
          icon={satelliteIcon}
          title={trackName ?? "Satellite"}
          eventHandlers={{ click: () => onClearTrack?.() }}
        >
          <Popup>{trackName ?? "Satellite"}</Popup>
        </Marker>
      ) : null}
      <FitBounds points={points} />
      <FitTrack points={trackPoints} trackKey={trackKey} />
    </MapContainer>
  );
}
