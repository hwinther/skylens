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

/**
 * Opens the cockpit view of the first aircraft with the Esri imagery/terrain blocked: these tests are
 * about the look-around HUD, and in CI's software WebGL the tile decoding starved the main thread so
 * much that mouse input timed out. The globe still renders (plain), the camera still follows.
 */
async function openAircraftCockpit(page: Page) {
  await page.route(/arcgis(online)?\.com/, (route) => route.abort())
  await page.goto('/list')
  const row = page.locator('[data-testid^="list-ac-"]').first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await page.getByTestId('detail-cockpit').click()
  await expect(page.getByTestId('sim-view').locator('canvas')).toBeVisible({ timeout: 30_000 })
}

test('looking around shows where straight ahead is, and Recenter snaps back', async ({ page }) => {
  await openAircraftCockpit(page)

  // Straight ahead: the flight-path marker is on screen and there is nothing to recenter.
  const forward = page.getByTestId('sim-forward')
  await expect(forward).toHaveAttribute('data-onscreen', 'true', { timeout: 30_000 })
  await expect(page.getByTestId('sim-recenter')).toHaveCount(0)

  // Drag 800 px to the left = look right, past the edge of the view. Dispatched straight to the view:
  // the same pointer handlers, without waiting for input acks from a busy WebGL page.
  await page.getByTestId('sim-view').evaluate((el) => {
    const send = (type: string, x: number) =>
      el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 300, pointerId: 1, bubbles: true }))
    send('pointerdown', 1000)
    for (let x = 920; x >= 200; x -= 80) send('pointermove', x)
    send('pointerup', 200)
  })

  await expect(page.getByTestId('sim-look-offset')).toHaveText(/\d° right/)
  // 800 px × 0.15°/px = 120° right: straight ahead is behind-left, so the marker is an edge arrow.
  await expect(forward).toHaveAttribute('data-onscreen', 'false')

  await page.getByTestId('sim-recenter').click()
  await expect(page.getByTestId('sim-recenter')).toHaveCount(0)
  await expect(forward).toHaveAttribute('data-onscreen', 'true')
})

test.describe('on a phone', () => {
  test.use({
    isMobile: true,
    hasTouch: true,
    viewport: { width: 412, height: 860 },
    // Chromium gates DeviceOrientation behind these (the in-app request resolves 'denied' without them).
    // `permissions` replaces the config's list, so geolocation is repeated: in container mode the app
    // has no baked home position and shows no traffic without it.
    permissions: ['geolocation', 'accelerometer', 'gyroscope', 'magnetometer'],
    geolocation: { latitude: 59.9, longitude: 11.1 },
  })

  test('Pan/tilt aims the cockpit view with the device and Recenter resets it', async ({ page }) => {
    await openAircraftCockpit(page)
    const toggle = page.getByTestId('sim-look-device')
    await expect(toggle).toBeVisible()
    // An on/off toggle button: its state must reach the DOM (react-native-web drops accessibilityState).
    await expect(toggle).toHaveAttribute('role', 'button')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    // Feed DeviceOrientation like a phone held upright, first facing the start pose, then turned
    // ~40° to the right (alpha counts counter-clockwise).
    const orient = (alpha: number) =>
      page.evaluate((a) => {
        const name = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation'
        for (let i = 0; i < 30; i++) {
          const ev = new Event(name) as Event & Record<string, unknown>
          Object.assign(ev, { alpha: a, beta: 90, gamma: 0, absolute: true })
          window.dispatchEvent(ev)
        }
      }, alpha)
    await orient(0)
    await expect(toggle).toContainText('Pan/tilt on')
    // The render loop captures this pose as "straight ahead" on its next frame; turn only after that.
    await expect(page.getByTestId('sim-view')).toHaveAttribute('data-look-reference', 'true')
    await orient(320)

    await expect(page.getByTestId('sim-look-offset')).toHaveText(/^(3\d|4\d)° right/, { timeout: 10_000 })

    // Recenter: wherever the phone points now becomes straight ahead.
    await page.getByTestId('sim-recenter').click()
    await orient(320)
    await expect(page.getByTestId('sim-recenter')).toHaveCount(0)
  })
})
