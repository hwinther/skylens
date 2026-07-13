/**
 * Real geographic map for the web Map view: OpenStreetMap tiles with a heading-rotated marker per
 * aircraft and a marker for the observer. Web-only — imported solely from map.web.tsx, so leaflet
 * (which needs the DOM) never reaches the native bundle. Native's Map uses react-native-maps.
 */

import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import { MapContainer, Marker, TileLayer, useMap } from "react-leaflet";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { AircraftDto, VesselDto } from "@/api/types";
import { iconForCategory } from "@/components/aircraftIcon";
import { iconForVessel } from "@/components/vesselIcon";
import type { Observer } from "./relative";

export interface LeafletMapProps {
  aircraft: AircraftDto[];
  observer: Observer;
  onSelect: (hex: string) => void;
  /** AIS vessels to plot alongside aircraft; already filtered to the visible kinds by the caller. */
  vessels?: VesselDto[];
  /** Tap handler for a vessel marker (opens the vessel detail sheet). Markers are inert when omitted. */
  onSelectVessel?: (mmsi: string) => void;
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

const observerIcon = L.divIcon({
  className: "",
  html: `<div style="width:12px;height:12px;border-radius:6px;background:#7CFC9A;border:2px solid #0B1622;box-shadow:0 0 4px #000"></div>`,
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

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

export function LeafletMap({
  aircraft,
  observer,
  onSelect,
  vessels = [],
  onSelectVessel,
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

  return (
    <MapContainer center={[observer.lat, observer.lon]} zoom={9} style={{ height: "100%", width: "100%" }} preferCanvas>
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        maxZoom={19}
      />
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
      <FitBounds points={points} />
    </MapContainer>
  );
}
