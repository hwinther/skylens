/**
 * iconForVessel maps the AIS shipType/aidType ints onto the handful of watercraft glyphs MCI ships.
 * The mapping is coarse (colour, not glyph, is the class discriminator for the ferry family), so the
 * load-bearing guarantees are: the ranges land on the intended glyph, unknowns fall back, and — the
 * one that would break rendering silently — every returned name really exists in the icon glyphmap.
 */

import { iconForVessel, type VesselIconName } from "@/components/vesselIcon";
import type { VesselDto } from "@/api/types";
// The real MaterialCommunityIcons glyphmap (no `exports` field on the package, so the deep JSON path
// resolves) — the source of truth for which icon names actually render.
import glyphMap from "@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/MaterialCommunityIcons.json";

function ship(shipType: number | null): VesselDto {
  return { mmsi: "1", kind: "ship", shipType };
}
function aton(aidType: number | null, virtual?: boolean | null): VesselDto {
  return { mmsi: "1", kind: "aton", aidType, virtual };
}

describe("iconForVessel — ship types", () => {
  it("maps fishing (30) to the fish glyph", () => {
    expect(iconForVessel(ship(30)).name).toBe("fish");
  });

  it("maps tug / towing / special (31, 32, 52) to the ship-wheel glyph", () => {
    for (const t of [31, 32, 52]) expect(iconForVessel(ship(t)).name).toBe("ship-wheel");
  });

  it("maps sailing / pleasure (36, 37) to the sail-boat glyph", () => {
    for (const t of [36, 37]) expect(iconForVessel(ship(t)).name).toBe("sail-boat");
  });

  it("maps HSC (40–49), passenger (60–69), cargo (70–79) and tanker (80–89) to ferry, told apart by colour", () => {
    const family = [40, 60, 70, 80].map((t) => iconForVessel(ship(t)));
    for (const r of family) expect(r.name).toBe("ferry");
    // Colour is the discriminator for the ferry-family classes: all four must differ.
    expect(new Set(family.map((r) => r.color)).size).toBe(4);
  });

  it("falls back to the generic ferry for an unknown or absent ship type", () => {
    expect(iconForVessel(ship(999)).name).toBe("ferry");
    expect(iconForVessel(ship(null)).name).toBe("ferry");
  });
});

describe("iconForVessel — aids to navigation", () => {
  it("maps light types (1–8) to the lighthouse glyph", () => {
    for (const t of [1, 5, 8]) expect(iconForVessel(aton(t)).name).toBe("lighthouse");
  });

  it("maps fixed beacons (9–20) to the lit-lighthouse glyph", () => {
    for (const t of [9, 15, 20]) expect(iconForVessel(aton(t)).name).toBe("lighthouse-on");
  });

  it("maps floating buoys (21–31) and unknown/default to the life-ring glyph", () => {
    for (const t of [21, 31, 0, 99]) expect(iconForVessel(aton(t)).name).toBe("lifebuoy");
    expect(iconForVessel(aton(null)).name).toBe("lifebuoy");
  });

  it("gives a virtual AtoN a distinct glyph AND colour from the physical aid of the same type", () => {
    for (const t of [1, 9, 21, null]) {
      const physical = iconForVessel(aton(t, false));
      const virtual = iconForVessel(aton(t, true));
      // Both axes must differ so the phantom mark is unmistakable — colour alone isn't enough.
      expect(virtual.name).not.toBe(physical.name);
      expect(virtual.color).not.toBe(physical.color);
    }
    // The chosen phantom glyph is a hollow marker, constant regardless of the underlying aidType.
    expect(iconForVessel(aton(5, true)).name).toBe("map-marker-radius-outline");
  });

  it("treats an absent/false virtual flag as a physical aid (no phantom treatment)", () => {
    expect(iconForVessel(aton(5, false)).name).toBe("lighthouse");
    expect(iconForVessel(aton(5, null)).name).toBe("lighthouse");
    expect(iconForVessel(aton(5)).name).toBe("lighthouse");
  });
});

describe("iconForVessel — glyph existence", () => {
  it("every icon name it can return exists in the MaterialCommunityIcons glyphmap", () => {
    const samples: VesselDto[] = [
      ...[30, 31, 32, 36, 37, 40, 52, 60, 70, 80, 999, null].map(ship),
      ...[1, 8, 9, 20, 21, 31, 0, null].map((t) => aton(t)),
      // The virtual-AtoN phantom glyph is its own return path — sweep it too.
      aton(5, true),
      aton(21, true),
    ];
    const names = new Set<VesselIconName>(samples.map((v) => iconForVessel(v).name));
    // Sanity: the sweep actually exercised the distinct glyphs, not just one.
    expect(names.size).toBeGreaterThanOrEqual(6);
    for (const name of names) {
      expect(Object.prototype.hasOwnProperty.call(glyphMap, name as string)).toBe(true);
    }
  });
});
