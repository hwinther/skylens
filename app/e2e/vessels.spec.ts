/**
 * Live integration (maritime): the web frontend must render AIS vessels that originate from the
 * backend API — the ship counterpart to live.spec.ts's aircraft coverage.
 *
 * The API container replays a captured Oslo-fjord AIS stream (Mqtt__AisReplay + the baked
 * /app/fixtures/ais.jsonl) through its real parse → VesselStateStore → VesselBroadcaster → SignalR
 * pipeline. Vessels ride the same /hubs/aircraft connection as aircraft but arrive on their own
 * "vessels" message (0.2 Hz, nearest 300 within the viewer radius). If the browser shows a
 * `list-ship-*` row, the whole maritime chain — AIS parse, vessel store, broadcast filter, hub push,
 * vesselStore, render — worked end to end.
 *
 * Geometry: the fixture is real Oslo-fjord traffic (lat ~59.0-59.9, lon ~9.6-10.8). The compose FEED
 * origin and the Playwright geolocation are both pinned to 59.9,11.1; the Oslo cluster (~59.9,10.7)
 * sits ~18 km away, well inside the app's default 60 km subscription radius, so at least the nearest
 * vessels are always served. See playwright.ci.config.ts / docker-compose.e2e.yml for the wiring.
 *
 * NOTE (settings toggle): the task's optional "ships toggle in Settings hides the rows" assertion is
 * intentionally omitted. The existing e2e never navigates to Settings, the Show-ships Switch carries
 * no testID/accessible label, and adding a toggle drill would mean inventing a navigation + selector
 * pattern the suite doesn't otherwise use. The showShips/showAton gating is already covered by the
 * app-side jest tests; keeping it out of e2e stays faithful to the repo's conventions.
 */

import { test, expect } from "@playwright/test";

test("list tab shows AIS vessels streamed from the backend", async ({ page }) => {
  await page.goto("/list");

  // The combined Traffic heading is visible immediately; ships need the AIS replay to populate the
  // store plus a 0.2 Hz vessel broadcast, so allow a generous window for the first row to arrive.
  await expect(page.getByTestId("list-count")).toBeVisible();

  const shipRow = page.locator('[data-testid^="list-ship-"]').first();
  await expect(shipRow).toBeVisible({ timeout: 30_000 });

  // The row is keyed by a real AIS identity (MMSI) — proves it's a vessel row, not a stray match.
  const testId = (await shipRow.getAttribute("data-testid")) ?? "";
  const mmsi = testId.replace("list-ship-", "");
  expect(Number(mmsi), "ship rows are keyed list-ship-<mmsi>").toBeGreaterThan(0);

  // The row shows a distance ("<d.d> km <DIR>"); SOG/COG use "kn"/"°", so a decimal + "km" is
  // unambiguously the distance cell.
  const rowText = ((await shipRow.textContent()) ?? "").trim();
  expect(rowText, "ship row shows a distance from the observer").toMatch(/\d+\.\d\s*km/);

  // The row shows an identity: the vessel name (letters) or, when no static name has arrived, the
  // numeric MMSI fallback. Everything before the distance cell is that identity label.
  const label = rowText.slice(0, rowText.search(/\d+\.\d\s*km/));
  expect(
    label.includes(mmsi) || /[A-Za-z]{2,}/.test(label),
    "ship row shows a name or the MMSI",
  ).toBe(true);
});

test("radar plots AIS vessels streamed from the backend", async ({ page }) => {
  await page.goto("/map");

  // Radar is the default map view. Ships plot as their own blips; the radar auto-scales its range to
  // the farthest target, so vessels never clip the outer ring regardless of the observer offset.
  const shipBlip = page.getByTestId("map-web").locator('[data-testid^="map-ship-"]').first();
  await expect(shipBlip).toBeVisible({ timeout: 30_000 });
});
