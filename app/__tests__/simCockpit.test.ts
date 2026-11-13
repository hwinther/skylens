/**
 * Cockpit-view extras, pure policy: which traffic is drawn (range, cap, labels, signal lost, the
 * followed object, aids to navigation), its label text, the layer filter, the chase camera pose and
 * chevron, the great-circle route line, nearest place / destination text, where the controls go around
 * an open card, and the tap-vs-drag rule for picking.
 */

import type { AircraftDto, VesselDto } from "@/api/types";
import { AIRCRAFT_STALE_AFTER_S } from "@/ar/positionTracker";
import { color } from "@/theme";
import {
  chaseCamera,
  chaseSpec,
  chevronEnu,
  chevronSizeM,
  MAX_CHASE_ELEVATION_DEG,
  MIN_CHASE_ELEVATION_DEG,
} from "@/sim/chase";
import { hiddenSummary, SIM_LAYERS, simFilterChips, simLayersFor, simLayerVisibility } from "@/sim/layers";
import {
  CARD_GAP,
  cockpitLayout,
  CONTROL_COLUMN_FALLBACK_WIDTH,
  HUD_COLUMN_GAP,
  HUD_MIN_WIDTH,
  hudMaxWidth,
} from "@/sim/layout";
import { DOUBLE_TAP_MS, isTap, TAP_MAX_MS, TAP_SLOP_PX } from "@/sim/look";
import { distanceKm, type OverlayPlace } from "@/sim/overlay";
import {
  describeDestination,
  describeNearest,
  findPlaceByCode,
  formatKm,
  greatCirclePoints,
  nearestPlace,
} from "@/sim/route";
import {
  aircraftTrafficLabel,
  selectTraffic,
  TRAFFIC_MAX_LABELS,
  TRAFFIC_MAX_POINTS,
  trafficAltText,
  VESSEL_POINT_ALT_M,
  type TrafficInput,
} from "@/sim/traffic";
import { SIDE_PANEL_WIDTH } from "@/components/sheetLayout";

const NOW = 1_700_000_000_000;
const CENTRE = { lat: 60, lon: 10 };

const ac = (hex: string, over: Partial<AircraftDto> = {}): AircraftDto => ({
  hex,
  lat: 60.05,
  lon: 10,
  alt: 5000,
  gs: 200,
  trk: 90,
  seenPos: 0,
  ...over,
});
const ship = (mmsi: string, over: Partial<VesselDto> = {}): VesselDto => ({
  mmsi,
  kind: "ship",
  name: `SHIP ${mmsi}`,
  lat: 60.02,
  lon: 10,
  sog: 10,
  cog: 0,
  seen: 0,
  ...over,
});
const byId = <T>(list: T[], id: (t: T) => string) => Object.fromEntries(list.map((t) => [id(t), t]));

function input(over: Partial<TrafficInput> = {}): TrafficInput {
  return {
    aircraft: {},
    aircraftAt: NOW,
    vessels: {},
    vesselsAt: NOW,
    centre: CENTRE,
    followed: { kind: "aircraft", id: "own" },
    ownAltM: null,
    show: { aircraft: true, vessels: true },
    nowMs: NOW,
    ...over,
  };
}

describe("selectTraffic", () => {
  it("keeps positioned aircraft within 50 km and vessels within 20 km, never the followed object", () => {
    const aircraft = byId(
      [
        ac("own"),
        ac("near", { lat: 60.3 }), // ~33 km
        ac("far", { lat: 60.5 }), // ~56 km
        ac("nopos", { lat: null, lon: null }),
      ],
      (a) => a.hex,
    );
    const vessels = byId(
      [ship("v1", { lat: 60.15 }), ship("v2", { lat: 60.2 }), ship("buoy", { kind: "aton", lat: 60.01 })],
      (v) => v.mmsi,
    );
    const items = selectTraffic(input({ aircraft, vessels }));
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(["vessel:v1", "aircraft:near"]);
    expect(items.find((i) => i.id === "v1")?.altM).toBe(VESSEL_POINT_ALT_M);
  });

  it("leaves out traffic whose signal is lost, so nothing stale is drawn as if live", () => {
    const aircraft = byId(
      [ac("fresh"), ac("stale", { seenPos: AIRCRAFT_STALE_AFTER_S + 5 })],
      (a) => a.hex,
    );
    expect(selectTraffic(input({ aircraft })).map((i) => i.id)).toEqual(["fresh"]);
  });

  it("excludes the followed vessel when following a vessel, and honours the filter", () => {
    const vessels = byId([ship("own"), ship("other")], (v) => v.mmsi);
    const aircraft = byId([ac("a1")], (a) => a.hex);
    const following = input({ vessels, aircraft, followed: { kind: "vessel", id: "own" } });
    expect(selectTraffic(following).map((i) => i.id).sort()).toEqual(["a1", "other"]);
    expect(selectTraffic({ ...following, show: { aircraft: false, vessels: true } }).map((i) => i.id)).toEqual([
      "other",
    ]);
    expect(selectTraffic({ ...following, show: { aircraft: true, vessels: false } }).map((i) => i.id)).toEqual(["a1"]);
  });

  it("is nearest first, capped, and labels only the nearest few", () => {
    const list = Array.from({ length: TRAFFIC_MAX_POINTS + 10 }, (_, i) => ac(`a${i}`, { lat: 60 + (i + 1) * 0.003 }));
    const items = selectTraffic(input({ aircraft: byId(list, (a) => a.hex) }));
    expect(items).toHaveLength(TRAFFIC_MAX_POINTS);
    expect(items[0].id).toBe("a0");
    const d = items.map((i) => distanceKm(CENTRE.lat, CENTRE.lon, i.lat, i.lon));
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    expect(items.filter((i) => i.label).length).toBe(TRAFFIC_MAX_LABELS);
    expect(items[TRAFFIC_MAX_LABELS].label).toBe("");
  });

  it("colours military aircraft orange like the rest of the app, vessels teal", () => {
    const aircraft = byId([ac("mil", { mil: true }), ac("civ", { lat: 60.06 })], (a) => a.hex);
    const vessels = byId([ship("v")], (v) => v.mmsi);
    const items = selectTraffic(input({ aircraft, vessels }));
    expect(items.find((i) => i.id === "mil")?.color).toBe(color.military);
    expect(items.find((i) => i.id === "civ")?.color).toBe(color.entity.air);
    expect(items.find((i) => i.id === "v")?.color).toBe(color.entity.sea);
  });

  it("carries the kinematic sample, timed by when the position was true", () => {
    const [item] = selectTraffic(input({ aircraft: byId([ac("a", { seenPos: 2, gs: 100, trk: 45 })], (a) => a.hex) }));
    expect(item.timeMs).toBe(NOW - 2000);
    expect(item.headingDeg).toBe(45);
    expect(item.speedMps).toBeCloseTo(100 * 0.514444, 3);
  });
});

describe("traffic labels", () => {
  it("TCAS-style relative altitude next to a followed aircraft, absolute otherwise", () => {
    expect(trafficAltText(11_200, 10_000)).toBe("+12");
    expect(trafficAltText(9_500, 10_000)).toBe("−05");
    expect(trafficAltText(10_020, 10_000)).toBe("+00");
    expect(trafficAltText(35_000, null)).toBe("FL350");
    expect(trafficAltText(3_480, null)).toBe("3500 ft");
    expect(trafficAltText(null, 10_000)).toBe("");
  });

  it("uses the callsign, else the hex", () => {
    expect(aircraftTrafficLabel(ac("abc123", { flight: " SAS1 ", alt: 12_000 }), null)).toBe("SAS1 FL120");
    expect(aircraftTrafficLabel(ac("abc123", { flight: null, alt: null }), null)).toBe("ABC123");
  });

  it("relative altitude works through selectTraffic when following an aircraft", () => {
    const aircraft = byId([ac("b", { alt: 6200, flight: "B1" })], (a) => a.hex);
    const [item] = selectTraffic(input({ aircraft, ownAltM: 5000 * 0.3048 }));
    expect(item.label).toBe("B1 +12");
  });
});

describe("layer filter", () => {
  it("offers every layer at the surface and none from orbit", () => {
    expect(simLayersFor("aircraft")).toEqual([...SIM_LAYERS]);
    expect(simLayersFor("vessel")).toEqual([...SIM_LAYERS]);
    expect(simLayersFor("satellite")).toEqual([]);
  });

  it("turns the stored hidden ids into chips and visibility", () => {
    const chips = simFilterChips("vessel", ["ferries", "aircraft"]);
    expect(chips.map((c) => [c.layer, c.shown])).toEqual([
      ["aircraft", false],
      ["vessels", true],
      ["airports", true],
      ["ports", true],
      ["ferries", false],
    ]);
    expect(chips.find((c) => c.layer === "ferries")?.color).toBe(color.ferry);
    expect(simLayerVisibility(["ports"])).toEqual({
      aircraft: true,
      vessels: true,
      airports: true,
      ports: false,
      ferries: true,
    });
    expect(hiddenSummary(chips)).toBe("2 hidden");
    expect(hiddenSummary(simFilterChips("vessel", []))).toBe("");
  });
});

describe("chase camera", () => {
  const spec = chaseSpec("aircraft");

  it("sits straight behind and above at look = 0, looking at the object", () => {
    const cam = chaseCamera(90, { yaw: 0, pitch: 0 }, spec); // heading east
    expect(cam.east).toBeLessThan(0); // west of the object
    expect(Math.abs(cam.north)).toBeLessThan(1e-6);
    expect(cam.up).toBeCloseTo(spec.distanceM * Math.sin((spec.elevationDeg * Math.PI) / 180));
    expect(Math.hypot(cam.east, cam.north, cam.up)).toBeCloseTo(spec.distanceM);
    expect(cam.headingDeg).toBe(90);
    expect(cam.pitchDeg).toBe(-spec.elevationDeg);
  });

  it("orbits with the look offset: yaw turns the view, pitch moves the camera up or down", () => {
    const right = chaseCamera(0, { yaw: 90, pitch: 0 }, spec); // north-bound, look right (east)
    expect(right.headingDeg).toBe(90);
    expect(right.east).toBeLessThan(0); // camera west, looking east at the object
    const lookUp = chaseCamera(0, { yaw: 0, pitch: 8 }, spec);
    expect(lookUp.up).toBeLessThan(chaseCamera(0, { yaw: 0, pitch: 0 }, spec).up);
    expect(chaseCamera(0, { yaw: 0, pitch: 80 }, spec).pitchDeg).toBe(-MIN_CHASE_ELEVATION_DEG);
    expect(chaseCamera(0, { yaw: 0, pitch: -80 }, spec).pitchDeg).toBe(-MAX_CHASE_ELEVATION_DEG);
  });

  it("stands further back from a satellite than from a vessel", () => {
    expect(chaseSpec("satellite").distanceM).toBeGreaterThan(chaseSpec("aircraft").distanceM);
    expect(chaseSpec("aircraft").distanceM).toBeGreaterThan(chaseSpec("vessel").distanceM);
  });

  it("draws a closed chevron pointing along the heading", () => {
    const size = chevronSizeM(spec);
    const pts = chevronEnu(90, size);
    expect(pts).toHaveLength(5);
    expect(pts[0]).toEqual(pts[4]); // closed
    const nose = pts[1];
    expect(nose.east).toBeCloseTo(size * 0.6);
    expect(Math.abs(nose.north)).toBeLessThan(1e-9);
    // Wing tips behind the nose (west of it, for an east-bound object), either side of the track.
    expect(pts[0].east).toBeLessThan(0);
    expect(Math.sign(pts[0].north)).toBe(-Math.sign(pts[2].north));
  });
});

describe("route and nearest place", () => {
  const places: OverlayPlace[] = [
    { kind: "airport", code: "ENGM", name: "Oslo Gardermoen", lat: 60.1939, lon: 11.1004, altM: 208 },
    { kind: "airport", code: "ENKJ", name: "Kjeller", lat: 59.9693, lon: 11.0361, altM: 108 },
  ];

  it("follows the great circle between the ends, blending the altitude", () => {
    const a = { lat: 59.9, lon: 10.75, altM: 3000 };
    const b = { lat: 51.47, lon: -0.45, altM: 25 };
    const pts = greatCirclePoints(a, b, 32);
    expect(pts).toHaveLength(33);
    expect(pts[0].lat).toBeCloseTo(a.lat, 6);
    expect(pts[32].lon).toBeCloseTo(b.lon, 6);
    expect(pts[16].altM).toBeCloseTo((a.altM + b.altM) / 2);
    // Each segment is the same length on the sphere.
    const seg = (i: number) => distanceKm(pts[i].lat, pts[i].lon, pts[i + 1].lat, pts[i + 1].lon);
    expect(seg(0)).toBeCloseTo(seg(20), 3);
    // A great circle from Oslo to London bulges north of the straight lat/lon line.
    expect(pts[16].lat).toBeGreaterThan((a.lat + b.lat) / 2);
  });

  it("falls back to the two ends for coincident points", () => {
    const p = { lat: 60, lon: 10, altM: 0 };
    expect(greatCirclePoints(p, p)).toHaveLength(2);
  });

  it("finds a destination by its ICAO code, case-insensitively", () => {
    expect(findPlaceByCode(places, " engm ")?.name).toBe("Oslo Gardermoen");
    expect(findPlaceByCode(places, "EGLL")).toBeNull();
    expect(findPlaceByCode(places, null)).toBeNull();
  });

  it("describes the nearest place with distance and compass direction", () => {
    const near = nearestPlace(places, 59.95, 10.8);
    expect(near?.place.code).toBe("ENKJ");
    expect(describeNearest(near!)).toMatch(/^ENKJ 13 km E$/);
    expect(nearestPlace([], 59.95, 10.8)).toBeNull();
    const port: OverlayPlace = { kind: "ferry", code: "", name: "A very long ferry quay name", lat: 59.95, lon: 10.81, altM: 0 };
    expect(describeNearest(nearestPlace([port], 59.95, 10.8)!)).toMatch(/^A very long ferry…/);
  });

  it("formats distances and the destination line", () => {
    expect(formatKm(3.44)).toBe("3.4 km");
    expect(formatKm(12.6)).toBe("13 km");
    expect(describeDestination("ENGM", { lat: 59.95, lon: 10.8 }, places[0])).toMatch(/^ENGM \d+ km$/);
    expect(describeDestination("EGLL", { lat: 59.95, lon: 10.8 }, null)).toBe("EGLL");
  });
});

describe("cockpit layout around the card", () => {
  it("leaves everything in place without a card", () => {
    expect(cockpitLayout({ windowWidth: 400, windowHeight: 800, cardOpen: false, cardHeight: 300 })).toEqual({
      rightInset: 0,
      bottomInset: 0,
      minimapFits: true,
    });
  });

  it("lifts bottom controls above a compact card and drops the minimap behind a tall one", () => {
    expect(cockpitLayout({ windowWidth: 400, windowHeight: 800, cardOpen: true, cardHeight: 120 })).toEqual({
      rightInset: 0,
      bottomInset: 120 + CARD_GAP,
      minimapFits: true,
    });
    expect(cockpitLayout({ windowWidth: 400, windowHeight: 800, cardOpen: true, cardHeight: 600 }).minimapFits).toBe(
      false,
    );
  });

  it("moves right-hand controls left of a side panel", () => {
    expect(cockpitLayout({ windowWidth: 1280, windowHeight: 800, cardOpen: true, cardHeight: 800 })).toEqual({
      rightInset: SIDE_PANEL_WIDTH,
      bottomInset: 0,
      minimapFits: true,
    });
  });
});

describe("HUD width next to the control column", () => {
  // The CI phone (Pixel 6, 1080 px at 2.625 = 411 dp): before, the HUD stretched to its imagery note
  // (~350 dp) and its right-aligned values sat under Map / Outside view / Layers (~103 dp wide).
  const phone = { windowWidth: 411, hudLeft: 12, columnRight: 12, columnWidth: 103 };

  it("stops the HUD a gap short of the column, so the two never overlap", () => {
    const max = hudMaxWidth(phone);
    expect(max).toBe(411 - 12 - 12 - 103 - HUD_COLUMN_GAP);
    expect(phone.hudLeft + max + HUD_COLUMN_GAP).toBeLessThanOrEqual(
      phone.windowWidth - phone.columnRight - phone.columnWidth,
    );
  });

  it("follows the column as it widens (unfolded Layers panel) and moves with a side panel", () => {
    expect(hudMaxWidth({ ...phone, columnWidth: 150 })).toBe(411 - 12 - 12 - 150 - HUD_COLUMN_GAP);
    expect(hudMaxWidth({ windowWidth: 1280, hudLeft: 16, columnRight: 16 + SIDE_PANEL_WIDTH, columnWidth: 110 })).toBe(
      1280 - 16 - 16 - SIDE_PANEL_WIDTH - 110 - HUD_COLUMN_GAP,
    );
  });

  it("assumes a typical column width until it is measured, and never goes below the HUD's minimum", () => {
    expect(hudMaxWidth({ ...phone, columnWidth: 0 })).toBe(411 - 12 - 12 - CONTROL_COLUMN_FALLBACK_WIDTH - HUD_COLUMN_GAP);
    expect(hudMaxWidth({ ...phone, windowWidth: 280 })).toBe(HUD_MIN_WIDTH);
  });
});

describe("tap vs drag", () => {
  it("is a tap only when the press barely moved and was short", () => {
    const down = { x: 100, y: 100, t: 0 };
    expect(isTap(down, { x: 103, y: 104, t: 120 })).toBe(true);
    expect(isTap(down, { x: 100 + TAP_SLOP_PX + 1, y: 100, t: 120 })).toBe(false);
    expect(isTap(down, { x: 100, y: 100, t: TAP_MAX_MS + 1 })).toBe(false);
    expect(DOUBLE_TAP_MS).toBeLessThan(TAP_MAX_MS);
  });
});
