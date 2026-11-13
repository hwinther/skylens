/**
 * The AR overlay: a full-screen absolute layer over the camera preview that, on
 * every animation frame, reads the current pose + observer position from refs,
 * dead-reckons each aircraft to "now", projects it through the pinhole model,
 * declutters the labels, and renders them. Nothing here touches zustand per frame —
 * the aircraft list is passed in (updated at 1 Hz) and the pose comes from refs.
 */

import { alpha, color } from "@/theme";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import {
  AIRCRAFT_LABEL_BOX,
  AIRPORT_LABEL_HEIGHT_PX,
  declutter,
  declutterLayers,
  effectiveHFovDeg,
  estimateLabelWidth,
  ONE_LINE_LABEL_HEIGHT_PX,
  TWO_LINE_LABEL_HEIGHT_PX,
  extrapolateView,
  GROUP_PRIORITY,
  lookAngles,
  project,
  surfaceBandOffset,
  vesselMotionSample,
  VESSEL_DISTANCE_CAP_KM,
  VESSEL_RENDER_CAP,
  type CameraPose,
  type ClusterChip,
  type EclipticPoint,
  type GeoPoint,
  type PlacedLabel,
  type PlanetView,
  type ProjectionConfig,
  type RadioTargetView,
  type SatelliteView,
  type ScreenLabel,
  type SizedLabel,
} from "@/ar";
import type { AircraftDto, AirportDto, VesselDto } from "@/api/types";
import { AircraftLabel } from "./AircraftLabel";
import { VesselLabel } from "./VesselLabel";
import { SatelliteLabel } from "./SatelliteLabel";
import { PlanetLabel } from "./PlanetLabel";
import { RadioLabel } from "./RadioLabel";
import { AirportArLabel } from "./AirportArLabel";
import { airportArPriority, airportShortLabel } from "./webmap/airportStyle";
import { PositionTracker, type TrackPoint } from "@/ar/positionTracker";
import { lostAgeS } from "@/ar/signalLost";
import { aircraftSample } from "@/sim/simPose";

const aircraftId = (ac: AircraftDto) => ac.hex;
const vesselId = (v: VesselDto) => v.mmsi;

/** Ids of the aircraft (hex) and vessels (MMSI) whose signal is lost (src/ar/signalLost). */
export interface SignalLostIds {
  aircraft: readonly string[];
  vessels: readonly string[];
}

export interface ArOverlayProps {
  aircraft: AircraftDto[];
  /** Epoch ms the aircraft snapshot was received (for dead-reckoning age). */
  snapshotAt: number;
  /** AIS vessels (ships + AtoN) for the horizon surface band. */
  vessels?: VesselDto[];
  /** Epoch ms the vessel snapshot was received (for ship dead-reckoning age). */
  vesselsSnapshotAt?: number;
  /** Draw ships in the surface band. */
  showShips?: boolean;
  /** Draw aids-to-navigation (lighthouses, beacons, buoys) in the surface band. */
  showAton?: boolean;
  /** Satellites already reduced to observer-relative az/el at 1 Hz (SGP4 runs in useSatellites, never here). */
  satellites?: SatelliteView[];
  /** Epoch ms the satellite set was propagated at (for per-frame az/el extrapolation between 1 Hz ticks). */
  satellitesSampledAt?: number;
  /** Draw the orbital (satellite) pass. */
  showSatellites?: boolean;
  /** Solar-System bodies reduced to observer-relative az/el (computed at 30 s in usePlanets). */
  planets?: PlanetView[];
  /** Draw the planets sky pass (Sun, Moon, Mercury–Neptune). */
  showPlanets?: boolean;
  /** Sampled ecliptic arc (observer-relative az/el) for the faint sky line. */
  ecliptic?: EclipticPoint[];
  /** Draw the faint ecliptic line across the sky. */
  showEcliptic?: boolean;
  /** Tap handler for a planet label (opens the planet detail sheet). */
  onSelectPlanet?: (body: string) => void;
  /** Fixed radio sources reduced to observer-relative az/el (computed at 30 s in useRadioSky). */
  radioTargets?: RadioTargetView[];
  /** Draw the radio (hydrogen-line target) sky pass. */
  showRadioSky?: boolean;
  /** Tap handler for a radio label (opens the radio detail sheet). */
  onSelectRadio?: (key: string) => void;
  poseRef: React.MutableRefObject<CameraPose>;
  positionRef: React.MutableRefObject<GeoPoint | null>;
  hFovDeg: number;
  onSelect: (hex: string) => void;
  /** Tap handler for a satellite label (opens the Phase 5 detail sheet). */
  onSelectSatellite?: (noradId: number) => void;
  /** Tapping a vessel label's icon/name; omitted → vessel labels stay display-only. */
  onSelectVessel?: (mmsi: string) => void;
  /** Called when the set of signal-lost aircraft/vessels changes (for the detail card's status line). */
  onSignalLost?: (lost: SignalLostIds) => void;
  /** Airports (already filtered by the small-airfields toggle) for the fixed-infrastructure pass. */
  airports?: AirportDto[];
  /** Draw the airports pass. */
  showAirports?: boolean;
  /** Tap handler for an airport label (opens the airport detail sheet). */
  onSelectAirport?: (ident: string) => void;
  /** Draw synthetic orientation aids — horizon, ground plane, and cardinal (N/E/S/W) hints —
   *  when there's no camera feed to orient against. */
  showHorizon?: boolean;
  /** Drawn first, beneath every label (AR identify's long-press catcher): inside the overlay, so on web
   *  it is what the pointer hits wherever no label is, while labels on top still take their taps. */
  underlay?: React.ReactNode;
}

interface RenderLabel {
  aircraft: AircraftDto;
  x: number;
  y: number;
  anchorY: number;
  rangeKm: number | null;
  /** Whole seconds since the last position when the signal is lost, else null. */
  lostAgeS: number | null;
}

interface RenderArrow {
  hex: string;
  bearingDeg: number;
  lost: boolean;
}

interface RenderVessel {
  vessel: VesselDto;
  x: number;
  y: number;
  anchorY: number;
  rangeKm: number;
  lostAgeS: number | null;
}

interface RenderSatellite {
  satellite: SatelliteView;
  x: number;
  y: number;
  anchorY: number;
}

interface RenderPlanet {
  planet: PlanetView;
  x: number;
  y: number;
  anchorY: number;
}

interface RenderRadio {
  target: RadioTargetView;
  x: number;
  y: number;
  anchorY: number;
}

interface RenderAirport {
  airport: AirportDto;
  x: number;
  y: number;
  anchorY: number;
}

interface ClusterMark {
  x: number;
  y: number;
  count: number;
}

// Stable empty references so a frame with no vessels bails out of a re-render instead of swapping in
// a fresh [] every ~50 ms.
const NO_VESSELS: RenderVessel[] = [];
const NO_CLUSTERS: ClusterMark[] = [];
const NO_SATELLITES: RenderSatellite[] = [];
const NO_PLANETS: RenderPlanet[] = [];
const NO_RADIO: RenderRadio[] = [];
const NO_AIRPORTS_RENDER: RenderAirport[] = [];
const NO_ECLIPTIC_MARKS: { x: number; y: number }[] = [];
// Stable defaults for the optional list props so an omitted prop doesn't re-run the ref-sync effect.
const NO_VESSELS_INPUT: VesselDto[] = [];
const NO_SATELLITES_INPUT: SatelliteView[] = [];
const NO_PLANETS_INPUT: PlanetView[] = [];
const NO_RADIO_INPUT: RadioTargetView[] = [];
const NO_AIRPORTS_INPUT: AirportDto[] = [];
const NO_ECLIPTIC_INPUT: EclipticPoint[] = [];
// Stable no-ops so an omitted select handler doesn't allocate a new callback (and re-memo labels) each render.
const noopSelectSatellite = (_noradId: number) => {};
const noopSelectPlanet = (_body: string) => {};
const noopSelectRadio = (_key: string) => {};
const noopSelectAirport = (_ident: string) => {};

/** Keep the rendered labels that were placed, moved to their decluttered y (anchor kept for the leader). */
function applyPlacement<T extends { y: number; anchorY: number }>(
  render: T[],
  placed: PlacedLabel[],
  idOf: (l: T) => string,
): T[] {
  const byId = new Map(placed.map((p) => [p.id, p]));
  const out: T[] = [];
  for (const l of render) {
    const p = byId.get(idOf(l));
    if (p) out.push({ ...l, y: p.y, anchorY: p.anchorY });
  }
  return out;
}

const toClusterMark = (c: ClusterChip): ClusterMark => ({ x: c.x, y: c.y, count: c.count });

interface CardinalMark {
  label: string;
  x: number;
  primary: boolean;
}

/** Cardinal points to hint on the horizon. N/S are emphasised; E/W are lighter. */
const CARDINALS: { label: string; az: number; primary: boolean }[] = [
  { label: "N", az: 0, primary: true },
  { label: "E", az: 90, primary: false },
  { label: "S", az: 180, primary: true },
  { label: "W", az: 270, primary: false },
];

export function ArOverlay({
  aircraft,
  snapshotAt,
  vessels = NO_VESSELS_INPUT,
  vesselsSnapshotAt = 0,
  showShips = false,
  showAton = false,
  satellites = NO_SATELLITES_INPUT,
  satellitesSampledAt = 0,
  showSatellites = false,
  planets = NO_PLANETS_INPUT,
  showPlanets = false,
  ecliptic = NO_ECLIPTIC_INPUT,
  showEcliptic = false,
  onSelectPlanet,
  radioTargets = NO_RADIO_INPUT,
  showRadioSky = false,
  onSelectRadio,
  airports = NO_AIRPORTS_INPUT,
  showAirports = false,
  onSelectAirport,
  poseRef,
  positionRef,
  hFovDeg,
  onSelect,
  onSelectSatellite,
  onSelectVessel,
  onSignalLost,
  showHorizon = false,
  underlay,
}: ArOverlayProps) {
  const { width, height } = useWindowDimensions();
  const [labels, setLabels] = useState<RenderLabel[]>([]);
  const [arrows, setArrows] = useState<RenderArrow[]>([]);
  const [clusters, setClusters] = useState<{ x: number; y: number; count: number }[]>([]);
  const [vesselLabels, setVesselLabels] = useState<RenderVessel[]>(NO_VESSELS);
  const [vesselClusters, setVesselClusters] = useState<ClusterMark[]>(NO_CLUSTERS);
  const [satLabels, setSatLabels] = useState<RenderSatellite[]>(NO_SATELLITES);
  const [satClusters, setSatClusters] = useState<ClusterMark[]>(NO_CLUSTERS);
  const [planetLabels, setPlanetLabels] = useState<RenderPlanet[]>(NO_PLANETS);
  const [planetClusters, setPlanetClusters] = useState<ClusterMark[]>(NO_CLUSTERS);
  const [radioLabels, setRadioLabels] = useState<RenderRadio[]>(NO_RADIO);
  const [radioClusters, setRadioClusters] = useState<ClusterMark[]>(NO_CLUSTERS);
  const [airportLabels, setAirportLabels] = useState<RenderAirport[]>(NO_AIRPORTS_RENDER);
  const [airportClusters, setAirportClusters] = useState<ClusterMark[]>(NO_CLUSTERS);
  const [eclipticMarks, setEclipticMarks] = useState<{ x: number; y: number }[]>(NO_ECLIPTIC_MARKS);
  // Screen y (px) of the elevation-0 horizon at the current pose; null when not shown.
  const [horizonY, setHorizonY] = useState<number | null>(null);
  // Cardinal-point hints (N/E/S/W) that are within the horizontal FOV this frame.
  const [cardinals, setCardinals] = useState<CardinalMark[]>([]);

  // Smoothed positions, fed once per snapshot (not per frame): each sample is timed by its position's
  // own age (seenPos / seen), a repeated position of a moving object doesn't pull the label back, and the
  // remaining prediction error fades out instead of jumping. Ids that leave the snapshot are dropped.
  const [aircraftTracker] = useState(() => new PositionTracker());
  const [vesselTracker] = useState(() => new PositionTracker());
  // Declared before the ref-sync effect so the tracker already knows every aircraft in the new list.
  useEffect(() => {
    const receivedAt = snapshotAt || Date.now();
    aircraftTracker.sync(aircraft, aircraftId, (ac) => aircraftSample(ac, receivedAt), Date.now());
  }, [aircraftTracker, aircraft, snapshotAt]);
  useEffect(() => {
    const receivedAt = vesselsSnapshotAt || Date.now();
    // AtoN are fixed and never dead-reckon, so they aren't tracked.
    vesselTracker.sync(
      vessels,
      vesselId,
      (v) => (v.kind === "aton" ? null : vesselMotionSample(v, receivedAt)),
      Date.now(),
    );
  }, [vesselTracker, vessels, vesselsSnapshotAt]);

  // Keep the latest inputs in refs so the rAF loop (started once) reads fresh data.
  // Syncing happens in an effect (not during render) so ref writes stay side-effects.
  const aircraftRef = useRef(aircraft);
  const hFovRef = useRef(hFovDeg);
  const showHorizonRef = useRef(showHorizon);
  const vesselsRef = useRef(vessels);
  const showShipsRef = useRef(showShips);
  const showAtonRef = useRef(showAton);
  const satellitesRef = useRef(satellites);
  const satellitesSampledAtRef = useRef(satellitesSampledAt);
  const showSatellitesRef = useRef(showSatellites);
  const planetsRef = useRef(planets);
  const showPlanetsRef = useRef(showPlanets);
  const radioTargetsRef = useRef(radioTargets);
  const showRadioSkyRef = useRef(showRadioSky);
  const airportsRef = useRef(airports);
  const showAirportsRef = useRef(showAirports);
  const eclipticRef = useRef(ecliptic);
  const showEclipticRef = useRef(showEcliptic);
  useEffect(() => {
    aircraftRef.current = aircraft;
    hFovRef.current = hFovDeg;
    showHorizonRef.current = showHorizon;
    vesselsRef.current = vessels;
    showShipsRef.current = showShips;
    showAtonRef.current = showAton;
    satellitesRef.current = satellites;
    satellitesSampledAtRef.current = satellitesSampledAt;
    showSatellitesRef.current = showSatellites;
    planetsRef.current = planets;
    showPlanetsRef.current = showPlanets;
    radioTargetsRef.current = radioTargets;
    showRadioSkyRef.current = showRadioSky;
    airportsRef.current = airports;
    showAirportsRef.current = showAirports;
    eclipticRef.current = ecliptic;
    showEclipticRef.current = showEcliptic;
  }, [aircraft, hFovDeg, showHorizon, vessels, showShips, showAton, satellites, satellitesSampledAt, showSatellites, planets, showPlanets, radioTargets, showRadioSky, airports, showAirports, ecliptic, showEcliptic]);

  // The signal-lost callback lives in its own ref so the rAF loop never restarts for it.
  const onSignalLostRef = useRef(onSignalLost);
  useEffect(() => {
    onSignalLostRef.current = onSignalLost;
  }, [onSignalLost]);

  useEffect(() => {
    let raf = 0;
    let lastRun = 0;
    // Last reported signal-lost set, so onSignalLost only fires when it changes.
    let lostKey = "";
    // Cap the overlay's heavy work (reprojecting N aircraft + declutter + the label-tree
    // re-render) at ~20 fps. The rAF keeps firing at display rate, but doing all that 60x/s
    // pins the JS thread the moment planes are present — starving touch handling and the pose
    // loop (the "frozen, can't tap, planes stuck as arrows" symptom). 20 fps still tracks the sky.
    const MIN_INTERVAL_MS = 1000 / 20;
    const config: ProjectionConfig = {
      // hFovRef is the base FOV calibrated for portrait width; effectiveHFovDeg widens it in
      // landscape so the constant camera focal length is preserved as the screen rotates.
      hFovDeg: effectiveHFovDeg(hFovRef.current, width / height),
      aspect: width / height,
      cullMargin: 0.15,
    };
    // Reused for every tracked position lookup, so the loop doesn't allocate one per object per frame.
    const pos: TrackPoint = { lat: 0, lon: 0, alt: 0 };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const nowMs = Date.now();
      if (nowMs - lastRun < MIN_INTERVAL_MS) return;
      lastRun = nowMs;

      const pose = poseRef.current;
      const observer = positionRef.current;
      config.hFovDeg = effectiveHFovDeg(hFovRef.current, width / height);
      config.aspect = width / height;

      const nextLabels: RenderLabel[] = [];
      const nextArrows: RenderArrow[] = [];
      const screenLabels: ScreenLabel[] = [];
      const lostAircraft: string[] = [];
      const lostVessels: string[] = [];

      if (observer) {
        for (const ac of aircraftRef.current) {
          // Unknown to the tracker = no position in the snapshot.
          if (!aircraftTracker.positionAt(ac.hex, nowMs, pos)) continue;
          const acLostAgeS = lostAgeS(aircraftTracker.sampleOf(ac.hex), nowMs);
          if (acLostAgeS != null) lostAircraft.push(ac.hex);
          const angles = lookAngles(observer, pos);
          const proj = project(
            { azimuth: angles.azimuth, elevation: angles.elevation },
            pose,
            config,
          );
          const px = (proj.xNdc * width) / 2 + width / 2;
          const py = height / 2 - (proj.yNdc * height) / 2;
          if (proj.onScreen) {
            screenLabels.push({
              id: ac.hex,
              x: px,
              y: py,
              priority: 1 / Math.max(angles.slantRange, 1), // closer = higher
            });
            nextLabels.push({
              aircraft: ac,
              x: px,
              y: py,
              anchorY: py,
              rangeKm: angles.slantRange / 1000,
              lostAgeS: acLostAgeS,
            });
          } else if (proj.arrowBearingDeg != null) {
            nextArrows.push({ hex: ac.hex, bearingDeg: proj.arrowBearingDeg, lost: acLostAgeS != null });
          }
        }
      }

      const { placed, clusters: chips } = declutter(screenLabels);
      const placedById = new Map(placed.map((p) => [p.id, p]));
      const decluttered = nextLabels
        .filter((l) => placedById.has(l.aircraft.hex))
        .map((l) => {
          const p = placedById.get(l.aircraft.hex)!;
          return { ...l, y: p.y, anchorY: p.anchorY };
        });

      setLabels(decluttered);
      setArrows(nextArrows);
      setClusters(chips.map((c) => ({ x: c.x, y: c.y, count: c.count })));

      // --- Surface band: ships + AtoN pinned to the horizon at their true bearing ---
      // A vessel's real elevation is a jittery near-zero angle, so we ignore it: project the point
      // { azimuth, elevation: 0 } (on the horizon) and push it down by a distance-scaled offset.
      // Nearest-first, distance-capped, hard-capped, and decluttered in a SEPARATE pass so aircraft
      // label placement is completely untouched. Off-screen vessels get no edge arrow — the band is
      // dense and side arrows would just be horizon noise (aircraft keep theirs).
      if (observer && (showShipsRef.current || showAtonRef.current)) {
        const cand: { v: VesselDto; azimuth: number; distKm: number; lostAgeS: number | null }[] = [];
        for (const v of vesselsRef.current) {
          if (v.lat == null || v.lon == null) continue;
          const isAton = v.kind === "aton";
          if (isAton ? !showAtonRef.current : !showShipsRef.current) continue;
          // Ships dead-reckon along cog/sog between snapshots (smoothed by the tracker); AtoN are fixed.
          if (isAton) {
            pos.lat = v.lat;
            pos.lon = v.lon;
          } else if (!vesselTracker.positionAt(v.mmsi, nowMs, pos)) {
            continue;
          }
          const vLostAgeS = isAton ? null : lostAgeS(vesselTracker.sampleOf(v.mmsi), nowMs);
          if (vLostAgeS != null) lostVessels.push(v.mmsi);
          pos.alt = 0;
          const a = lookAngles(observer, pos);
          const distKm = a.slantRange / 1000;
          if (distKm > VESSEL_DISTANCE_CAP_KM) continue;
          cand.push({ v, azimuth: a.azimuth, distKm, lostAgeS: vLostAgeS });
        }
        // Nearest-first, then hard-cap before the (O(n²)) projection + declutter work.
        cand.sort((p, q) => p.distKm - q.distKm);
        const capped = cand.length > VESSEL_RENDER_CAP ? cand.slice(0, VESSEL_RENDER_CAP) : cand;

        const vScreenLabels: ScreenLabel[] = [];
        const vRender: RenderVessel[] = [];
        for (const c of capped) {
          const proj = project({ azimuth: c.azimuth, elevation: 0 }, pose, config);
          if (!proj.onScreen) continue;
          const px = (proj.xNdc * width) / 2 + width / 2;
          const horizonPy = height / 2 - (proj.yNdc * height) / 2;
          const py = horizonPy + surfaceBandOffset(c.distKm);
          vScreenLabels.push({ id: c.v.mmsi, x: px, y: py, priority: 1 / Math.max(c.distKm, 0.1) });
          vRender.push({ vessel: c.v, x: px, y: py, anchorY: py, rangeKm: c.distKm, lostAgeS: c.lostAgeS });
        }

        if (vRender.length === 0) {
          setVesselLabels(NO_VESSELS);
          setVesselClusters(NO_CLUSTERS);
        } else {
          const { placed: vPlaced, clusters: vChips } = declutter(vScreenLabels);
          const vById = new Map(vPlaced.map((p) => [p.id, p]));
          const vDecluttered = vRender
            .filter((l) => vById.has(l.vessel.mmsi))
            .map((l) => {
              const p = vById.get(l.vessel.mmsi)!;
              return { ...l, y: p.y, anchorY: p.anchorY };
            });
          setVesselLabels(vDecluttered);
          setVesselClusters(vChips.map((c) => ({ x: c.x, y: c.y, count: c.count })));
        }
      } else {
        setVesselLabels(NO_VESSELS);
        setVesselClusters(NO_CLUSTERS);
      }

      const nextLostKey = `${lostAircraft.join(",")}|${lostVessels.join(",")}`;
      if (nextLostKey !== lostKey) {
        lostKey = nextLostKey;
        onSignalLostRef.current?.({ aircraft: lostAircraft, vessels: lostVessels });
      }

      // --- Airports pass: fixed ground infrastructure at their true az/el ---
      // Airports sit at ground level, so — unlike the vessel band's forced horizon — we keep each one's
      // REAL elevation (lat/lon + field elevation through the same look-angle math as aircraft). At
      // distance that places them on or just under the horizon; we never elevation-mask them. Placed in
      // the joint sky declutter below (last layer); the busier classes (large > medium) keep their
      // un-pushed spot. No edge arrows — off-screen airports simply don't draw. The set is already
      // filtered by the small-airfields toggle upstream, so this just projects what it's given.
      const aScreenLabels: SizedLabel[] = [];
      const aRender: RenderAirport[] = [];
      if (observer && showAirportsRef.current && airportsRef.current.length) {
        for (const ap of airportsRef.current) {
          const alt = (ap.elevationFt ?? 0) * 0.3048; // ft → m; unknown elevation → sea level
          const angles = lookAngles(observer, { lat: ap.lat, lon: ap.lon, alt });
          const proj = project({ azimuth: angles.azimuth, elevation: angles.elevation }, pose, config);
          if (!proj.onScreen) continue;
          const px = (proj.xNdc * width) / 2 + width / 2;
          const py = height / 2 - (proj.yNdc * height) / 2;
          aScreenLabels.push({
            id: ap.ident,
            x: px,
            y: py,
            priority: airportArPriority(ap.type),
            width: estimateLabelWidth([airportShortLabel(ap)], { charPx: 6.5, chromePx: 27, maxWidth: 120 }),
            height: AIRPORT_LABEL_HEIGHT_PX,
          });
          aRender.push({ airport: ap, x: px, y: py, anchorY: py });
        }
      }

      // --- Orbital pass: satellites at their precomputed az/el, extrapolated to "now" ---
      // useSatellites already ran SGP4 + the look-angle transforms at 1 Hz. Rather than re-project the
      // fixed az/el (which visibly steps once a second for a fast LEO), we extrapolate each view by its
      // carried angular rates over the sample age — one glide instead of a stutter. The age is clamped
      // inside extrapolateView so a stalled tick can't fling labels. Placed in the joint sky declutter
      // below; priority keeps stations above GNSS, then higher elevation. No edge arrows — off-screen
      // satellites simply don't draw.
      const sScreenLabels: SizedLabel[] = [];
      const sRender: RenderSatellite[] = [];
      if (showSatellitesRef.current && satellitesRef.current.length) {
        const satAgeS = Math.max(0, (Date.now() - satellitesSampledAtRef.current) / 1000);
        for (const s of satellitesRef.current) {
          const { azimuthDeg, elevationDeg } = extrapolateView(s, satAgeS);
          const proj = project({ azimuth: azimuthDeg, elevation: elevationDeg }, pose, config);
          if (!proj.onScreen) continue;
          const px = (proj.xNdc * width) / 2 + width / 2;
          const py = height / 2 - (proj.yNdc * height) / 2;
          // Higher priority = keeps its un-pushed spot: stations first (−GROUP_PRIORITY), then the
          // higher-in-the-sky within a group as the tiebreak.
          const priority = -(GROUP_PRIORITY[s.group] ?? 99) * 1000 + s.elevationDeg;
          const title = s.name.trim() || String(s.noradId);
          const sub = s.freqSummary ? `00°  ${s.freqSummary}` : "00°";
          sScreenLabels.push({
            id: String(s.noradId),
            x: px,
            y: py,
            priority,
            width: estimateLabelWidth([title, sub], { maxWidth: 170 }),
            height: TWO_LINE_LABEL_HEIGHT_PX,
          });
          sRender.push({ satellite: s, x: px, y: py, anchorY: py });
        }
      }

      // --- Sky pass: Solar-System bodies at their computed az/el (usePlanets recomputes at 30 s) ---
      // Real elevation, projected like satellites (not the vessel horizon band). Placed first in the
      // joint sky declutter below; brighter (lower-magnitude) bodies keep the spot.
      const pScreenLabels: SizedLabel[] = [];
      const pRender: RenderPlanet[] = [];
      if (showPlanetsRef.current && planetsRef.current.length) {
        for (const p of planetsRef.current) {
          const proj = project({ azimuth: p.azimuthDeg, elevation: p.elevationDeg }, pose, config);
          if (!proj.onScreen) continue;
          const px = (proj.xNdc * width) / 2 + width / 2;
          const py = height / 2 - (proj.yNdc * height) / 2;
          pScreenLabels.push({
            id: p.body,
            x: px,
            y: py,
            priority: -(p.magnitude ?? 10),
            width: estimateLabelWidth([p.name.trim() || p.body], { maxWidth: 150 }),
            height: p.magnitude != null ? TWO_LINE_LABEL_HEIGHT_PX : ONE_LINE_LABEL_HEIGHT_PX,
          });
          pRender.push({ planet: p, x: px, y: py, anchorY: py });
        }
      }

      // --- Radio pass: fixed hydrogen-line sources at their computed az/el (useRadioSky, 30 s) ---
      // Same real-elevation projection as the planets pass (the caller passes only above-horizon
      // targets, so no elevation mask here). Placed in the joint sky declutter below; higher-in-the-sky
      // keeps its un-pushed spot (all four sources are of similar interest).
      const rScreenLabels: SizedLabel[] = [];
      const rRender: RenderRadio[] = [];
      if (showRadioSkyRef.current && radioTargetsRef.current.length) {
        for (const t of radioTargetsRef.current) {
          const proj = project({ azimuth: t.azimuthDeg, elevation: t.elevationDeg }, pose, config);
          if (!proj.onScreen) continue;
          const px = (proj.xNdc * width) / 2 + width / 2;
          const py = height / 2 - (proj.yNdc * height) / 2;
          rScreenLabels.push({
            id: t.key,
            x: px,
            y: py,
            priority: t.elevationDeg,
            width: estimateLabelWidth([t.short.trim() || t.name.trim() || t.key], { maxWidth: 150 }),
            height: ONE_LINE_LABEL_HEIGHT_PX,
          });
          rRender.push({ target: t, x: px, y: py, anchorY: py });
        }
      }

      // --- Joint sky declutter: planets > satellites > radio > airports, around the aircraft ---
      // Placed as sized boxes in one pass so two-line chips stack without overlapping and kinds never
      // sit on each other. The aircraft labels (placed above, untouched) are fixed obstacles, so no
      // sky label covers one; an earlier layer is never pushed by a later one.
      const [pRes, sRes, rRes, aRes] = declutterLayers(
        [pScreenLabels, sScreenLabels, rScreenLabels, aScreenLabels],
        decluttered.map((l) => ({ x: l.x, y: l.y, ...AIRCRAFT_LABEL_BOX })),
      );
      setPlanetLabels(pRender.length ? applyPlacement(pRender, pRes.placed, (l) => l.planet.body) : NO_PLANETS);
      setPlanetClusters(pRes.clusters.length ? pRes.clusters.map(toClusterMark) : NO_CLUSTERS);
      setSatLabels(
        sRender.length ? applyPlacement(sRender, sRes.placed, (l) => String(l.satellite.noradId)) : NO_SATELLITES,
      );
      setSatClusters(sRes.clusters.length ? sRes.clusters.map(toClusterMark) : NO_CLUSTERS);
      setRadioLabels(rRender.length ? applyPlacement(rRender, rRes.placed, (l) => l.target.key) : NO_RADIO);
      setRadioClusters(rRes.clusters.length ? rRes.clusters.map(toClusterMark) : NO_CLUSTERS);
      setAirportLabels(
        aRender.length ? applyPlacement(aRender, aRes.placed, (l) => l.airport.ident) : NO_AIRPORTS_RENDER,
      );
      setAirportClusters(aRes.clusters.length ? aRes.clusters.map(toClusterMark) : NO_CLUSTERS);

      // --- Ecliptic arc: the faint great-circle the planets ride, as on-screen dots ---
      if (showEclipticRef.current && eclipticRef.current.length) {
        const marks: { x: number; y: number }[] = [];
        for (const e of eclipticRef.current) {
          const proj = project({ azimuth: e.azimuthDeg, elevation: e.elevationDeg }, pose, config);
          if (!proj.onScreen) continue;
          marks.push({ x: (proj.xNdc * width) / 2 + width / 2, y: height / 2 - (proj.yNdc * height) / 2 });
        }
        setEclipticMarks(marks.length ? marks : NO_ECLIPTIC_MARKS);
      } else {
        setEclipticMarks(NO_ECLIPTIC_MARKS);
      }

      // Synthetic horizon + compass. Pose-only (no observer needed), so it orients you even
      // before a GPS fix. Cardinal points sit on the horizon (elevation 0) at their azimuth,
      // and are shown only while inside the horizontal FOV.
      if (showHorizonRef.current) {
        const h = project({ azimuth: pose.azimuth, elevation: 0 }, pose, config);
        setHorizonY(height / 2 - (h.yNdc * height) / 2);

        const marks: CardinalMark[] = [];
        for (const c of CARDINALS) {
          const p = project({ azimuth: c.az, elevation: 0 }, pose, config);
          if (!p.behind && Math.abs(p.xNdc) <= 1) {
            marks.push({ label: c.label, x: (p.xNdc * width) / 2 + width / 2, primary: c.primary });
          }
        }
        setCardinals(marks);
      }

    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [width, height, poseRef, positionRef, aircraftTracker, vesselTracker]);

  return (
    <View style={[StyleSheet.absoluteFill, { pointerEvents: "box-none" }]}>
      {underlay}
      {showHorizon && horizonY != null && (
        <>
          <View
            testID="ar-ground"
            style={[styles.ground, { top: Math.max(0, Math.min(height, horizonY)) }]}
          />
          {horizonY >= 0 && horizonY <= height && (
            <View testID="ar-horizon" style={[styles.horizon, { top: horizonY }]} />
          )}
          {cardinals.map((c) => (
            <Text
              key={c.label}
              testID={`compass-${c.label}`}
              style={[
                styles.cardinal,
                c.primary && styles.cardinalPrimary,
                { left: c.x - 10, top: horizonY + 4 },
              ]}
            >
              {c.label}
            </Text>
          ))}
        </>
      )}
      {airportLabels.map((a) => (
        <AirportArLabel
          key={a.airport.ident}
          airport={a.airport}
          x={a.x}
          y={a.y}
          anchorY={a.anchorY}
          onPress={onSelectAirport ?? noopSelectAirport}
        />
      ))}
      {airportClusters.map((c, i) => (
        <View key={`acl${i}`} style={[styles.airportCluster, { left: c.x, top: c.y }]}>
          <Text style={styles.airportClusterText}>+{c.count}</Text>
        </View>
      ))}
      {vesselLabels.map((v) => (
        <VesselLabel
          key={v.vessel.mmsi}
          vessel={v.vessel}
          x={v.x}
          y={v.y}
          anchorY={v.anchorY}
          rangeKm={v.rangeKm}
          lostAgeS={v.lostAgeS}
          onPress={onSelectVessel}
        />
      ))}
      {vesselClusters.map((c, i) => (
        <View key={`vcl${i}`} style={[styles.vesselCluster, { left: c.x, top: c.y }]}>
          <Text style={styles.vesselClusterText}>+{c.count}</Text>
        </View>
      ))}
      {satLabels.map((s) => (
        <SatelliteLabel
          key={s.satellite.noradId}
          satellite={s.satellite}
          x={s.x}
          y={s.y}
          anchorY={s.anchorY}
          onPress={onSelectSatellite ?? noopSelectSatellite}
        />
      ))}
      {satClusters.map((c, i) => (
        <View key={`scl${i}`} style={[styles.satCluster, { left: c.x, top: c.y }]}>
          <Text style={styles.satClusterText}>+{c.count}</Text>
        </View>
      ))}
      {eclipticMarks.map((m, i) => (
        <View key={`ecl${i}`} style={[styles.eclipticDot, { left: m.x - 1.5, top: m.y - 1.5 }]} />
      ))}
      {planetLabels.map((p) => (
        <PlanetLabel
          key={p.planet.body}
          planet={p.planet}
          x={p.x}
          y={p.y}
          anchorY={p.anchorY}
          onPress={onSelectPlanet ?? noopSelectPlanet}
        />
      ))}
      {planetClusters.map((c, i) => (
        <View key={`pcl${i}`} style={[styles.planetCluster, { left: c.x, top: c.y }]}>
          <Text style={styles.planetClusterText}>+{c.count}</Text>
        </View>
      ))}
      {radioLabels.map((r) => (
        <RadioLabel
          key={r.target.key}
          target={r.target}
          x={r.x}
          y={r.y}
          anchorY={r.anchorY}
          onPress={onSelectRadio ?? noopSelectRadio}
        />
      ))}
      {radioClusters.map((c, i) => (
        <View key={`rcl${i}`} style={[styles.radioCluster, { left: c.x, top: c.y }]}>
          <Text style={styles.radioClusterText}>+{c.count}</Text>
        </View>
      ))}
      {labels.map((l) => (
        <AircraftLabel
          key={l.aircraft.hex}
          aircraft={l.aircraft}
          x={l.x}
          y={l.y}
          anchorY={l.anchorY}
          rangeKm={l.rangeKm}
          lostAgeS={l.lostAgeS}
          onPress={onSelect}
        />
      ))}
      {clusters.map((c, i) => (
        <View key={`cl${i}`} style={[styles.cluster, { left: c.x, top: c.y }]}>
          <Text style={styles.clusterText}>+{c.count}</Text>
        </View>
      ))}
      {arrows.map((a) => (
        <View
          key={`ar${a.hex}`}
          testID={`ac-arrow-${a.hex}`}
          style={[styles.arrow, arrowPosition(a.bearingDeg, width, height)]}
        >
          {a.lost ? (
            // Signal lost: a hollow, dimmed arrow, like the label's hollow anchor dot.
            <Text testID={`ar-ac-arrow-lost-${a.hex}`} style={[styles.arrowText, styles.arrowTextLost]}>
              △
            </Text>
          ) : (
            <Text style={styles.arrowText}>▲</Text>
          )}
        </View>
      ))}
    </View>
  );
}

/** Place an off-screen arrow at the frame edge along the given screen bearing. */
function arrowPosition(bearingDeg: number, width: number, height: number) {
  const rad = (bearingDeg * Math.PI) / 180;
  const cx = width / 2;
  const cy = height / 2;
  const margin = 28;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const x = cx + dx * (width / 2 - margin);
  const y = cy + dy * (height / 2 - margin);
  return { left: x - 12, top: y - 12, transform: [{ rotate: `${bearingDeg}deg` }] };
}

const styles = StyleSheet.create({
  // Earthy fill below the horizon so "down" is obvious against the navy "sky" when there's
  // no camera; the horizon line is the level reference you tilt against.
  ground: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(20, 46, 30, 0.7)",
    pointerEvents: "none",
  },
  horizon: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: alpha(color.entity.air, 0.6),
    pointerEvents: "none",
  },
  // Light cardinal hints on the horizon; N/S emphasised over E/W.
  cardinal: {
    position: "absolute",
    width: 20,
    textAlign: "center",
    color: alpha(color.text, 0.5),
    fontSize: 12,
    fontWeight: "600",
    pointerEvents: "none",
  },
  cardinalPrimary: {
    color: alpha(color.text, 0.92),
    fontSize: 13,
    fontWeight: "800",
  },
  cluster: {
    position: "absolute",
    backgroundColor: "rgba(255, 180, 80, 0.85)",
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    transform: [{ translateX: -12 }, { translateY: -10 }],
  },
  clusterText: { color: "#1a1a1a", fontSize: 11, fontWeight: "700" },
  // Marine-tinted "+N" chip for vessels collapsed by the band declutter; non-interactive.
  vesselCluster: {
    position: "absolute",
    backgroundColor: alpha(color.entity.sea, 0.85),
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    transform: [{ translateX: -12 }, { translateY: -10 }],
    pointerEvents: "none",
  },
  vesselClusterText: { color: "#062026", fontSize: 11, fontWeight: "700" },
  // Violet "+N" chip for satellites collapsed by the orbital-pass declutter; non-interactive.
  satCluster: {
    position: "absolute",
    backgroundColor: alpha(color.entity.orbit, 0.85),
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    transform: [{ translateX: -12 }, { translateY: -10 }],
    pointerEvents: "none",
  },
  satClusterText: { color: "#1a0f26", fontSize: 11, fontWeight: "700" },
  planetCluster: {
    position: "absolute",
    backgroundColor: alpha(color.entity.sky, 0.9),
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    transform: [{ translateX: -12 }, { translateY: -10 }],
    pointerEvents: "none",
  },
  planetClusterText: { color: "#241a05", fontSize: 11, fontWeight: "700" },
  // Signal-lime "+N" chip for radio sources collapsed by the radio-pass declutter; non-interactive.
  radioCluster: {
    position: "absolute",
    backgroundColor: alpha(color.entity.radio, 0.9),
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    transform: [{ translateX: -12 }, { translateY: -10 }],
    pointerEvents: "none",
  },
  radioClusterText: { color: color.bg, fontSize: 11, fontWeight: "700" },
  // Steel-blue "+N" chip for airports collapsed by the airports-pass declutter; non-interactive.
  airportCluster: {
    position: "absolute",
    backgroundColor: alpha(color.airport, 0.85),
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    transform: [{ translateX: -12 }, { translateY: -10 }],
    pointerEvents: "none",
  },
  airportClusterText: { color: color.bg, fontSize: 11, fontWeight: "700" },
  // Faint gold dot marking a sampled point on the ecliptic arc.
  eclipticDot: {
    position: "absolute",
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: alpha(color.entity.sky, 0.4),
    pointerEvents: "none",
  },
  arrow: { position: "absolute", width: 24, height: 24, alignItems: "center", justifyContent: "center", pointerEvents: "none" },
  arrowText: { color: alpha(color.entity.air, 0.9), fontSize: 18 },
  arrowTextLost: { color: alpha(color.entity.air, 0.45) },
});
