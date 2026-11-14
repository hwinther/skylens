/**
 * The tiltable Radar on web, against the real backend and the committed ETOPO terrain grids (Development
 * reads data/terrain/terrain.bin.gz; the image bakes it). The app is in live mode at the fixture home
 * (east of Oslo), so the replayed aircraft are on the scope.
 *
 * - Flat by default: the classic scope, no relief and no terrain request.
 * - The tilt control is an adjustable slider: a click tilts to 45° and fetches the area's grid once
 *   (GET /api/terrain), which is drawn as relief with the ETOPO credit; the blips stay tappable.
 * - Dragging the control up / down changes the tilt; a click on a tilted scope flattens it again, and
 *   the tilt survives a reload (settingsStore).
 */

import { expect, test } from './fixtures'

test('the radar tilts into a relief view of the area, fetched once from the terrain endpoint', async ({ page }) => {
  const terrainRequests: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/api/terrain')) terrainRequests.push(req.url())
  })

  await page.goto('/map')
  await page.getByTestId('map-view-radar').click()
  const radar = page.getByTestId('radar')
  await expect(radar.locator('[data-testid^="map-ac-"]').first()).toBeVisible({ timeout: 30_000 })

  // A fixed range (one zoom step), so the auto range can't move while the replayed traffic does.
  await page.getByTestId('radar-zoom-in').click()

  // Flat: today's scope, nothing fetched.
  const tilt = page.getByTestId('radar-tilt')
  await expect(tilt).toBeVisible()
  await expect(tilt).toHaveAttribute('aria-label', 'Radar tilt')
  await expect(page.getByTestId('radar-tilt-value')).toHaveText('0°')
  await expect(page.getByTestId('radar-terrain')).toHaveCount(0)
  expect(terrainRequests).toEqual([])

  // A click tilts to 45° and fetches the grid for the area, drawn as relief with its credit.
  const response = page.waitForResponse((r) => r.url().includes('/api/terrain'))
  await tilt.click()
  const res = await response
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.size).toBeGreaterThan(1)
  expect(body.heights).toHaveLength(body.size * body.size)
  expect(body.attribution).toBe('ETOPO 2022 (NOAA NCEI)')
  await expect(page.getByTestId('radar-tilt-value')).toHaveText('45°')
  await expect(page.getByTestId('radar-terrain')).toHaveCount(1)
  await expect(page.getByTestId('radar-terrain-attribution')).toContainText('ETOPO 2022 (NOAA NCEI)')

  // Blips stay tappable on the tilted scope.
  await radar.locator('[data-testid^="map-ac-"]').first().click()
  await expect(page.getByTestId('detail-card')).toBeVisible()
  await page.getByTestId('detail-card-close').click()

  // Drag the control: down flattens part-way, up tilts further. Mouse drags go through the same
  // gesture handler as touch.
  const box = (await tilt.boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx, cy + i * 3)
  await page.mouse.up()
  const lower = Number.parseInt((await page.getByTestId('radar-tilt-value').textContent()) ?? '', 10)
  expect(lower).toBeLessThan(45)
  expect(lower).toBeGreaterThan(0)

  await page.mouse.move(cx, cy)
  await page.mouse.down()
  for (let i = 1; i <= 15; i++) await page.mouse.move(cx, cy - i * 6)
  await page.mouse.up()
  await expect(page.getByTestId('radar-tilt-value')).toHaveText('80°')

  // The same area and range reuse the grid: no second request.
  expect(terrainRequests).toHaveLength(1)

  // The tilt is remembered across a reload.
  await page.reload()
  await page.getByTestId('map-view-radar').click()
  await expect(page.getByTestId('radar-tilt-value')).toHaveText('80°')
  await expect(page.getByTestId('radar-terrain')).toHaveCount(1, { timeout: 30_000 })

  // A click on a tilted scope flattens it: the relief goes, the classic scope is back.
  await page.getByTestId('radar-tilt').click()
  await expect(page.getByTestId('radar-tilt-value')).toHaveText('0°')
  await expect(page.getByTestId('radar-terrain')).toHaveCount(0)
})
