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
