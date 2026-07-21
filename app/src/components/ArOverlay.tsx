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
  declutter,
  deadReckonVessel,
  effectiveHFovDeg,
  extrapolateView,
  GROUP_PRIORITY,
  lookAngles,
  project,
  surfaceBandOffset,
  VESSEL_DISTANCE_CAP_KM,
  VESSEL_RENDER_CAP,
  type CameraPose,
  type EclipticPoint,
  type GeoPoint,
  type PlanetView,
  type ProjectionConfig,
  type RadioTargetView,
  type SatelliteView,
  type ScreenLabel,
} from "@/ar";
import type { AircraftDto, AirportDto, VesselDto } from "@/api/types";
import { AircraftLabel } from "./AircraftLabel";
import { VesselLabel } from "./VesselLabel";
import { SatelliteLabel } from "./SatelliteLabel";
import { PlanetLabel } from "./PlanetLabel";
import { RadioLabel } from "./RadioLabel";
import { AirportArLabel } from "./AirportArLabel";
import { airportArPriority } from "./webmap/airportStyle";
import { deadReckon } from "@/ar/smoothing";

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
  /** Airports (already filtered by the small-airfields toggle) for the fixed-infrastructure pass. */
  airports?: AirportDto[];
  /** Draw the airports pass. */
  showAirports?: boolean;
  /** Tap handler for an airport label (opens the airport detail sheet). */
  onSelectAirport?: (ident: string) => void;
  /** Draw synthetic orientation aids — horizon, ground plane, and cardinal (N/E/S/W) hints —
   *  when there's no camera feed to orient against. */
  showHorizon?: boolean;
}

interface RenderLabel {
  aircraft: AircraftDto;
  x: number;
  y: number;
  anchorY: number;
  rangeKm: number | null;
}

interface RenderArrow {
  hex: string;
  bearingDeg: number;
}

interface RenderVessel {
  vessel: VesselDto;
  x: number;
  y: number;
  anchorY: number;
  rangeKm: number;
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
  showHorizon = false,
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

  // Keep the latest inputs in refs so the rAF loop (started once) reads fresh data.
  // Syncing happens in an effect (not during render) so ref writes stay side-effects.
  const aircraftRef = useRef(aircraft);
  const snapshotAtRef = useRef(snapshotAt);
  const hFovRef = useRef(hFovDeg);
  const showHorizonRef = useRef(showHorizon);
  const vesselsRef = useRef(vessels);
  const vesselsSnapshotAtRef = useRef(vesselsSnapshotAt);
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
    snapshotAtRef.current = snapshotAt;
    hFovRef.current = hFovDeg;
    showHorizonRef.current = showHorizon;
    vesselsRef.current = vessels;
    vesselsSnapshotAtRef.current = vesselsSnapshotAt;
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
  }, [aircraft, snapshotAt, hFovDeg, showHorizon, vessels, vesselsSnapshotAt, showShips, showAton, satellites, satellitesSampledAt, showSatellites, planets, showPlanets, radioTargets, showRadioSky, airports, showAirports, ecliptic, showEcliptic]);

  useEffect(() => {
    let raf = 0;
    let lastRun = 0;
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

      if (observer) {
        const ageS = Math.max(0, (Date.now() - snapshotAtRef.current) / 1000);
        for (const ac of aircraftRef.current) {
          if (ac.lat == null || ac.lon == null) continue;
          const alt = (ac.alt ?? 0) * 0.3048; // ft → m
          const dr = deadReckon(
            { lat: ac.lat, lon: ac.lon, alt, gs: ac.gs ?? 0, trk: ac.trk ?? 0, vr: ac.vr ?? 0 },
            ageS,
          );
          const angles = lookAngles(observer, { lat: dr.lat, lon: dr.lon, alt: dr.alt });
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
            });
          } else if (proj.arrowBearingDeg != null) {
            nextArrows.push({ hex: ac.hex, bearingDeg: proj.arrowBearingDeg });
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
        const vAgeS = Math.max(0, (Date.now() - vesselsSnapshotAtRef.current) / 1000);
        const cand: { v: VesselDto; azimuth: number; distKm: number }[] = [];
        for (const v of vesselsRef.current) {
          if (v.lat == null || v.lon == null) continue;
          const isAton = v.kind === "aton";
          if (isAton ? !showAtonRef.current : !showShipsRef.current) continue;
          // Ships dead-reckon along cog/sog between 5 s snapshots; AtoN are fixed and never do.
          const pos = isAton
            ? { lat: v.lat, lon: v.lon }
            : deadReckonVessel({ lat: v.lat, lon: v.lon, sog: v.sog, cog: v.cog }, vAgeS);
          const a = lookAngles(observer, { lat: pos.lat, lon: pos.lon, alt: 0 });
          const distKm = a.slantRange / 1000;
          if (distKm > VESSEL_DISTANCE_CAP_KM) continue;
          cand.push({ v, azimuth: a.azimuth, distKm });
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
          vRender.push({ vessel: c.v, x: px, y: py, anchorY: py, rangeKm: c.distKm });
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

      // --- Airports pass: fixed ground infrastructure at their true az/el ---
      // Airports sit at ground level, so — unlike the vessel band's forced horizon — we keep each one's
      // REAL elevation (lat/lon + field elevation through the same look-angle math as aircraft). At
      // distance that places them on or just under the horizon; we never elevation-mask them. Own
      // declutter pass so aircraft/vessel/satellite placement is untouched; the busier classes (large >
      // medium) keep their un-pushed spot. No edge arrows — off-screen airports simply don't draw. The
      // set is already filtered by the small-airfields toggle upstream, so this just projects what it's given.
      if (observer && showAirportsRef.current && airportsRef.current.length) {
        const aScreenLabels: ScreenLabel[] = [];
        const aRender: RenderAirport[] = [];
        for (const ap of airportsRef.current) {
          const alt = (ap.elevationFt ?? 0) * 0.3048; // ft → m; unknown elevation → sea level
          const angles = lookAngles(observer, { lat: ap.lat, lon: ap.lon, alt });
          const proj = project({ azimuth: angles.azimuth, elevation: angles.elevation }, pose, config);
          if (!proj.onScreen) continue;
          const px = (proj.xNdc * width) / 2 + width / 2;
          const py = height / 2 - (proj.yNdc * height) / 2;
          aScreenLabels.push({ id: ap.ident, x: px, y: py, priority: airportArPriority(ap.type) });
          aRender.push({ airport: ap, x: px, y: py, anchorY: py });
        }

        if (aRender.length === 0) {
          setAirportLabels(NO_AIRPORTS_RENDER);
          setAirportClusters(NO_CLUSTERS);
        } else {
          const { placed: aPlaced, clusters: aChips } = declutter(aScreenLabels);
          const aById = new Map(aPlaced.map((p) => [p.id, p]));
          const aDecluttered = aRender
            .filter((l) => aById.has(l.airport.ident))
            .map((l) => {
              const p = aById.get(l.airport.ident)!;
              return { ...l, y: p.y, anchorY: p.anchorY };
            });
          setAirportLabels(aDecluttered);
          setAirportClusters(aChips.map((c) => ({ x: c.x, y: c.y, count: c.count })));
        }
      } else {
        setAirportLabels(NO_AIRPORTS_RENDER);
        setAirportClusters(NO_CLUSTERS);
      }

      // --- Orbital pass: satellites at their precomputed az/el, extrapolated to "now" ---
      // useSatellites already ran SGP4 + the look-angle transforms at 1 Hz. Rather than re-project the
      // fixed az/el (which visibly steps once a second for a fast LEO), we extrapolate each view by its
      // carried angular rates over the sample age — one glide instead of a stutter. The age is clamped
      // inside extrapolateView so a stalled tick can't fling labels. Own declutter pass so aircraft/
      // vessel placement is untouched; priority keeps stations above GNSS, then higher elevation. No
      // edge arrows — off-screen satellites simply don't draw.
      if (showSatellitesRef.current && satellitesRef.current.length) {
        const satAgeS = Math.max(0, (Date.now() - satellitesSampledAtRef.current) / 1000);
        const sScreenLabels: ScreenLabel[] = [];
        const sRender: RenderSatellite[] = [];
        for (const s of satellitesRef.current) {
          const { azimuthDeg, elevationDeg } = extrapolateView(s, satAgeS);
          const proj = project({ azimuth: azimuthDeg, elevation: elevationDeg }, pose, config);
          if (!proj.onScreen) continue;
          const px = (proj.xNdc * width) / 2 + width / 2;
          const py = height / 2 - (proj.yNdc * height) / 2;
          // Higher priority = keeps its un-pushed spot: stations first (−GROUP_PRIORITY), then the
          // higher-in-the-sky within a group as the tiebreak.
          const priority = -(GROUP_PRIORITY[s.group] ?? 99) * 1000 + s.elevationDeg;
          sScreenLabels.push({ id: String(s.noradId), x: px, y: py, priority });
          sRender.push({ satellite: s, x: px, y: py, anchorY: py });
        }

        if (sRender.length === 0) {
          setSatLabels(NO_SATELLITES);
          setSatClusters(NO_CLUSTERS);
        } else {
          const { placed: sPlaced, clusters: sChips } = declutter(sScreenLabels);
          const sById = new Map(sPlaced.map((p) => [p.id, p]));
          const sDecluttered = sRender
            .filter((l) => sById.has(String(l.satellite.noradId)))
            .map((l) => {
              const p = sById.get(String(l.satellite.noradId))!;
              return { ...l, y: p.y, anchorY: p.anchorY };
            });
          setSatLabels(sDecluttered);
          setSatClusters(sChips.map((c) => ({ x: c.x, y: c.y, count: c.count })));
        }
      } else {
        setSatLabels(NO_SATELLITES);
        setSatClusters(NO_CLUSTERS);
      }

      // --- Sky pass: Solar-System bodies at their computed az/el (usePlanets recomputes at 30 s) ---
      // Real elevation, projected like satellites (not the vessel horizon band). Own declutter pass so
      // aircraft/vessel/satellite placement is untouched; brighter (lower-magnitude) bodies keep the spot.
      if (showPlanetsRef.current && planetsRef.current.length) {
        const pScreenLabels: ScreenLabel[] = [];
        const pRender: RenderPlanet[] = [];
        for (const p of planetsRef.current) {
          const proj = project({ azimuth: p.azimuthDeg, elevation: p.elevationDeg }, pose, config);
          if (!proj.onScreen) continue;
          const px = (proj.xNdc * width) / 2 + width / 2;
          const py = height / 2 - (proj.yNdc * height) / 2;
          pScreenLabels.push({ id: p.body, x: px, y: py, priority: -(p.magnitude ?? 10) });
          pRender.push({ planet: p, x: px, y: py, anchorY: py });
        }
        if (pRender.length === 0) {
          setPlanetLabels(NO_PLANETS);
          setPlanetClusters(NO_CLUSTERS);
        } else {
          const { placed: pPlaced, clusters: pChips } = declutter(pScreenLabels);
          const pById = new Map(pPlaced.map((pl) => [pl.id, pl]));
          const pDecluttered = pRender
            .filter((l) => pById.has(l.planet.body))
            .map((l) => {
              const pl = pById.get(l.planet.body)!;
              return { ...l, y: pl.y, anchorY: pl.anchorY };
            });
          setPlanetLabels(pDecluttered);
          setPlanetClusters(pChips.map((c) => ({ x: c.x, y: c.y, count: c.count })));
        }
      } else {
        setPlanetLabels(NO_PLANETS);
        setPlanetClusters(NO_CLUSTERS);
      }

      // --- Radio pass: fixed hydrogen-line sources at their computed az/el (useRadioSky, 30 s) ---
      // Same real-elevation projection as the planets pass (the caller passes only above-horizon
      // targets, so no elevation mask here). Own declutter pass so the other classes are untouched;
      // higher-in-the-sky keeps its un-pushed spot (all four sources are of similar interest).
      if (showRadioSkyRef.current && radioTargetsRef.current.length) {
        const rScreenLabels: ScreenLabel[] = [];
        const rRender: RenderRadio[] = [];
        for (const t of radioTargetsRef.current) {
          const proj = project({ azimuth: t.azimuthDeg, elevation: t.elevationDeg }, pose, config);
          if (!proj.onScreen) continue;
          const px = (proj.xNdc * width) / 2 + width / 2;
          const py = height / 2 - (proj.yNdc * height) / 2;
          rScreenLabels.push({ id: t.key, x: px, y: py, priority: t.elevationDeg });
          rRender.push({ target: t, x: px, y: py, anchorY: py });
        }
        if (rRender.length === 0) {
          setRadioLabels(NO_RADIO);
          setRadioClusters(NO_CLUSTERS);
        } else {
          const { placed: rPlaced, clusters: rChips } = declutter(rScreenLabels);
          const rById = new Map(rPlaced.map((rl) => [rl.id, rl]));
          const rDecluttered = rRender
            .filter((l) => rById.has(l.target.key))
            .map((l) => {
              const rl = rById.get(l.target.key)!;
              return { ...l, y: rl.y, anchorY: rl.anchorY };
            });
          setRadioLabels(rDecluttered);
          setRadioClusters(rChips.map((c) => ({ x: c.x, y: c.y, count: c.count })));
        }
      } else {
        setRadioLabels(NO_RADIO);
        setRadioClusters(NO_CLUSTERS);
      }

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
  }, [width, height, poseRef, positionRef]);

  return (
    <View style={[StyleSheet.absoluteFill, { pointerEvents: "box-none" }]}>
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
          <Text style={styles.arrowText}>▲</Text>
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
});
