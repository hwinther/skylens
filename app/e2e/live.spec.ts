/**
 * Live integration: the web frontend must render aircraft that originate from the backend API.
 *
 * The app boots in live mode (EXPO_PUBLIC_FORCE_LIVE) pointed at the local backend, which replays a
 * captured aircraft.json through its real ingest → state → SignalR pipeline. If the browser shows a
 * positive aircraft count, the whole chain — hub connect, Subscribe, snapshot push, store, render —
 * worked end to end. See playwright.config.ts for how the two servers are wired.
 */

import { test, expect, type Page } from "@playwright/test";

/** Read the leading integer from the AR status strip's "N ac" label. */
async function statusCount(page: Page): Promise<number> {
  const text = await page.getByTestId("status-aircraft-count").textContent();
  const n = parseInt((text ?? "").trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

test("AR status strip renders aircraft streamed from the backend", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("status-aircraft-count")).toBeVisible();
  await expect
    .poll(() => statusCount(page), {
      message: "aircraft count should rise above 0 once the SignalR snapshot arrives",
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
});

test("AR overlay renders aircraft on web and drag-to-look aims the view", async ({ page }) => {
  await page.goto("/");

  // Live data has arrived.
  await expect
    .poll(() => statusCount(page), { timeout: 30_000 })
    .toBeGreaterThan(0);

  // The projection pipeline runs on web: each positioned aircraft shows as an on-screen
  // label or an off-screen edge arrow.
  const markers = page.locator('[data-testid^="ac-label-"], [data-testid^="ac-arrow-"]');
  await expect.poll(() => markers.count(), { timeout: 15_000 }).toBeGreaterThan(0);

  // Drag-to-look: pull the view down to the horizon (aircraft sit at low elevation), then
  // sweep the heading a full turn (~0.15°/px), checking for an on-screen label along the way.
  const box = (await page.locator("body").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const labels = page.locator('[data-testid^="ac-label-"]');

  const drag = async (fromX: number, fromY: number, toX: number, toY: number) => {
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps: 12 });
    await page.mouse.up();
  };

  await drag(cx, cy - 40, cx, cy + 40); // lower elevation toward the horizon

  // With no camera on web, the synthetic horizon / ground plane renders as an up/down reference.
  await expect(page.getByTestId("ar-ground")).toBeVisible();

  const compass = page.locator('[data-testid^="compass-"]');
  let sawLabel = (await labels.count()) > 0;
  let sawCompass = (await compass.count()) > 0;
  for (let i = 0; i < 20 && !(sawLabel && sawCompass); i++) {
    await drag(cx + 80, cy, cx - 80, cy); // rotate heading ~24° per step
    if (!sawLabel) sawLabel = (await labels.count()) > 0;
    if (!sawCompass) sawCompass = (await compass.count()) > 0;
  }
  expect(sawLabel, "a drag sweep should bring at least one aircraft label into the FOV").toBe(true);
  expect(sawCompass, "a compass hint (N/E/S/W) should appear while sweeping the heading").toBe(true);
});

test("map list renders aircraft from the backend", async ({ page }) => {
  await page.goto("/map");

  const heading = page.getByTestId("map-aircraft-count");
  await expect(heading).toBeVisible();
  await expect
    .poll(
      async () => {
        const match = (await heading.textContent())?.match(/\((\d+)\)/);
        return match ? parseInt(match[1], 10) : 0;
      },
      { message: "the map list should show at least one aircraft", timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  await expect(
    page.getByTestId("map-web").locator('[data-testid^="map-ac-"]').first(),
  ).toBeVisible();
});
