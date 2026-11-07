/**
 * Simulator (cockpit view): from a detail sheet, "Cockpit view" opens /sim, Cesium starts a WebGL globe,
 * and the HUD follows the target with live numbers.
 *
 * Asserts on the HUD and the canvas, not on pixels: headless Chromium renders WebGL in software and the
 * Esri tiles need internet access, so imagery may or may not arrive. The CSP guard still fails the spec
 * if Cesium (script, workers, styles) or the Esri hosts break the policy in container mode.
 */

import { expect, type Page, test } from './fixtures'

async function hudNumber(page: Page, testId: string): Promise<number> {
  const text = (await page.getByTestId(testId).textContent()) ?? ''
  return Number(text.replace(/[^\d.-]/g, ''))
}

test('aircraft cockpit view follows the plane', async ({ page }) => {
  await page.goto('/list')
  const row = page.locator('[data-testid^="list-ac-"]').first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()

  await page.getByTestId('detail-cockpit').click()
  await expect(page).toHaveURL(/\/sim\?.*kind=aircraft/)

  // Cesium boots and renders into a canvas inside the view.
  await expect(page.getByTestId('sim-view').locator('canvas')).toBeVisible({ timeout: 30_000 })

  // The HUD tracks the plane: a name, an altitude in feet, a heading, and live data.
  await expect(page.getByTestId('sim-name')).not.toHaveText('…')
  await expect(page.getByTestId('sim-alt')).toHaveText(/^\d+ ft$/)
  await expect(page.getByTestId('sim-heading')).toHaveText(/^\d+°$/)
  await expect(page.getByTestId('sim-status')).toHaveText(/Live|Data \d+ s old/, { timeout: 30_000 })
  const heading = await hudNumber(page, 'sim-heading')
  expect(heading).toBeGreaterThanOrEqual(0)
  expect(heading).toBeLessThan(360)

  // Exit returns to where we came from and ends the session.
  await page.getByTestId('sim-exit').click()
  await expect(page).not.toHaveURL(/\/sim/)
})

test('satellite cockpit view rides the orbit', async ({ page }) => {
  await page.goto('/list')
  const row = page.getByTestId(/^list-sat-\d+$/).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.getByTestId('sat-detail-title')).toBeVisible({ timeout: 15_000 })

  await page.getByTestId('sat-cockpit').click()
  await expect(page).toHaveURL(/\/sim\?.*kind=satellite/)
  await expect(page.getByTestId('sim-view').locator('canvas')).toBeVisible({ timeout: 30_000 })

  // Propagated from the fixture TLE: some orbit between LEO and GEO, moving at orbital speed.
  await expect(page.getByTestId('sim-alt')).toHaveText(/^\d+ km$/, { timeout: 15_000 })
  const altKm = await hudNumber(page, 'sim-alt')
  expect(altKm).toBeGreaterThan(150)
  expect(altKm).toBeLessThan(40_000)
  await expect(page.getByTestId('sim-speed')).toHaveText(/^\d+\.\d{2} km\/s$/)
})

test('a deep link without a target offers a way back', async ({ page }) => {
  // A fresh browser is routed to onboarding first; skip it so the deep link itself is under test.
  await page.addInitScript(() => {
    localStorage.setItem('skylens.settings.v1', JSON.stringify({ state: { onboarded: true }, version: 0 }))
  })
  await page.goto('/sim')
  await expect(page.getByText('Nothing to follow')).toBeVisible()
  await expect(page.getByTestId('sim-exit')).toBeVisible()
})

test('the minimap follows the object and opens the full map', async ({ page }) => {
  await page.goto('/list')
  const row = page.locator('[data-testid^="list-ac-"]').first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await page.getByTestId('detail-cockpit').click()

  // The inset shows OSM tiles under a heading arrow.
  const minimap = page.getByTestId('sim-minimap')
  await expect(minimap).toBeVisible({ timeout: 30_000 })
  await expect(minimap.locator('.leaflet-container')).toBeVisible()
  await expect(page.getByTestId('sim-minimap-arrow')).toBeVisible()

  // Tapping it hands the aircraft to the Map, which focuses it.
  await page.getByTestId('sim-minimap-open').click()
  await expect(page).toHaveURL(/\/map/)
  await expect(page.getByTestId('map-focus-follow')).toContainText('Following')
})
