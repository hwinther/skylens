/**
 * Other traffic in the cockpit view's 3D scene: which aircraft and vessels near the followed object get a
 * point (and the nearest a short label), from the live stores the app already has. While a session is
 * active the root layout centres the hub subscription on the followed object (simStore, SIM_RADIUS_KM),
 * so the stores hold exactly the neighbourhood: no new backend call.
 *
 * Each item carries the same kinematic sample the camera's tracker uses (aircraftSample / vesselSample,
 * timed by when the position was true), so the globe dead-reckons it per frame with the AR view's
 * PositionTracker and it moves smoothly between the ~1 Hz updates. Targets whose signal is lost
 * (src/ar/signalLost) are left out rather than drawn as if live.
 *
 * Pure TS (no React, no Cesium) so jest runs it; the items are plain JSON, so on Android they cross the
 * bridge into the globe's webview as a prop.
 */

import type { AircraftDto, VesselDto } from "@/api/types";
import { isSignalLost } from "@/ar/signalLost";
import { color } from "@/theme";
import { distanceKm } from "./overlay";
import { aircraftSample, FEET_TO_M, vesselSample, type SimSample } from "./simPose";

/** Aircraft further than this from the followed object are not drawn. */
export const TRAFFIC_AIRCRAFT_RANGE_KM = 50;
/** Vessels further than this from the followed object are not drawn. */
export const TRAFFIC_VESSEL_RANGE_KM = 20;
/** At most this many points (nearest first)... */
export const TRAFFIC_MAX_POINTS = 60;
/** ...of which only the nearest this many carry a label; the rest are dots. */
export const TRAFFIC_MAX_LABELS = 20;
/** How often the screen re-selects traffic and hands it to the globe. */
export const TRAFFIC_UPDATE_MS = 1000;
/** A vessel's point sits this high above sea level (a hull, not the bridge camera height). */
export const VESSEL_POINT_ALT_M = 4;

export type TrafficKind = "aircraft" | "vessel";

export interface TrafficItem {
  kind: TrafficKind;
  /** Aircraft hex or vessel MMSI. */
  id: string;
  lat: number;
  lon: number;
  altM: number;
  speedMps: number;
  headingDeg: number;
  vertMps: number;
  /** Epoch ms at which the position was true (dead reckoning starts there). */
  timeMs: number;
  /** "" → point only. */
  label: string;
  /** CSS colour of the point and label. */
  color: string;
}

export interface TrafficInput {
  aircraft: Readonly<Record<string, AircraftDto>>;
  /** When the aircraft snapshot was received (aircraftStore.lastSnapshotAt). */
  aircraftAt: number;
  vessels: Readonly<Record<string, VesselDto>>;
  vesselsAt: number;
  /** The followed object now (the camera pose). */
  centre: { lat: number; lon: number };
  /** The followed object: never drawn as traffic. */
  followed: { kind: string; id: string };
  /** The followed aircraft's altitude in metres (labels then show relative altitude), else null. */
  ownAltM: number | null;
  show: { aircraft: boolean; vessels: boolean };
  nowMs: number;
}

/**
 * Altitude text for an aircraft label. Next to a followed aircraft: TCAS-style relative altitude in
 * hundreds of feet ("+12" = 1 200 ft above, "−05" = 500 ft below). Otherwise absolute: a flight level
 * from 10 000 ft, else feet rounded to 100. Null altitude → "".
 */
export function trafficAltText(altFt: number | null | undefined, ownAltFt: number | null): string {
  if (altFt == null || !Number.isFinite(altFt)) return "";
  if (ownAltFt != null) {
    const d = Math.round((altFt - ownAltFt) / 100);
    const mag = String(Math.abs(d)).padStart(2, "0");
    return `${d < 0 ? "−" : "+"}${mag}`;
  }
  if (altFt >= 10_000) return `FL${String(Math.round(altFt / 100)).padStart(3, "0")}`;
  return `${Math.round(altFt / 100) * 100} ft`;
}

/** An aircraft's label: callsign (or hex) plus the altitude text. */
export function aircraftTrafficLabel(ac: AircraftDto, ownAltFt: number | null): string {
  const name = ac.flight?.trim() || ac.hex.toUpperCase();
  const alt = trafficAltText(ac.alt, ownAltFt);
  return alt ? `${name} ${alt}` : name;
}

/** A vessel's label: its name, or the MMSI. */
export function vesselTrafficLabel(v: VesselDto): string {
  return v.name?.trim() || v.mmsi;
}

interface Candidate {
  d: number;
  item: TrafficItem;
}

function toItem(kind: TrafficKind, id: string, s: SimSample, altM: number, label: string, c: string): TrafficItem {
  return {
    kind,
    id,
    lat: s.lat,
    lon: s.lon,
    altM,
    speedMps: s.speedMps,
    headingDeg: s.headingDeg,
    vertMps: s.vertMps,
    timeMs: s.timeMs,
    label,
    color: c,
  };
}

/**
 * The traffic to draw: positioned, not lost, within range of the followed object, not the followed
 * object itself, the kind not filtered out; nearest first, at most TRAFFIC_MAX_POINTS, and only the
 * nearest TRAFFIC_MAX_LABELS labelled. Aids to navigation are not traffic and are left out. Military
 * aircraft are orange, as everywhere else in the app.
 */
export function selectTraffic(input: TrafficInput): TrafficItem[] {
  const { centre, followed, nowMs } = input;
  const ownAltFt = input.ownAltM != null ? input.ownAltM / FEET_TO_M : null;
  const out: Candidate[] = [];
  if (input.show.aircraft) {
    for (const ac of Object.values(input.aircraft)) {
      if (followed.kind === "aircraft" && ac.hex === followed.id) continue;
      const s = aircraftSample(ac, input.aircraftAt || nowMs);
      if (!s || isSignalLost(s, nowMs)) continue;
      const d = distanceKm(centre.lat, centre.lon, s.lat, s.lon);
      if (d > TRAFFIC_AIRCRAFT_RANGE_KM) continue;
      const c = ac.mil ? color.military : color.entity.air;
      out.push({ d, item: toItem("aircraft", ac.hex, s, s.altM, aircraftTrafficLabel(ac, ownAltFt), c) });
    }
  }
  if (input.show.vessels) {
    for (const v of Object.values(input.vessels)) {
      if (v.kind === "aton") continue;
      if (followed.kind === "vessel" && v.mmsi === followed.id) continue;
      const s = vesselSample(v, input.vesselsAt || nowMs);
      if (!s || isSignalLost(s, nowMs)) continue;
      const d = distanceKm(centre.lat, centre.lon, s.lat, s.lon);
      if (d > TRAFFIC_VESSEL_RANGE_KM) continue;
      out.push({
        d,
        item: toItem("vessel", v.mmsi, s, VESSEL_POINT_ALT_M, vesselTrafficLabel(v), color.entity.sea),
      });
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, TRAFFIC_MAX_POINTS).map(({ item }, i) => (i < TRAFFIC_MAX_LABELS ? item : { ...item, label: "" }));
}

/** A stable key for change detection (the Android screen only re-sends traffic that changed). */
export function trafficKey(items: readonly TrafficItem[]): string {
  return JSON.stringify(items);
}

/** What a tap on a traffic point picked. */
export interface TrafficPick {
  kind: TrafficKind;
  id: string;
}
