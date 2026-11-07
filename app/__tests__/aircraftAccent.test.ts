/**
 * Military airframes (`mil` from the tar1090-db / readsb dbFlags) get the military orange on every
 * surface (AR label, map markers, radar, list); everything else keeps the aircraft blue.
 */

import { aircraftAccent } from "@/components/aircraftIcon";
import { color } from "@/theme";

test("military aircraft use the military accent", () => {
  expect(aircraftAccent({ mil: true })).toBe(color.military);
});

test("civil or unflagged aircraft keep the aircraft blue", () => {
  expect(aircraftAccent({ mil: false })).toBe(color.entity.air);
  expect(aircraftAccent({ mil: null })).toBe(color.entity.air);
  expect(aircraftAccent({})).toBe(color.entity.air);
});

test("the military accent is distinct from the other entity colours", () => {
  expect(Object.values(color.entity)).not.toContain(color.military);
});
