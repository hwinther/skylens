/**
 * Cockpit view, outside camera: the followed object is drawn as the baked 3D model of its class
 * (app/public/models/sim/*.glb, app/src/sim/simModel.ts), loaded lazily when the outside view is first
 * switched on, with the point + chevron marker as the fallback while it loads or when it fails.
 *
 * What this proves: the app picks a class for the followed object, requests that file only once the
 * outside view is on, the server answers it (the dev server here; the API's static files in container
 * mode, which need the .glb content-type mapping), and Cesium decodes the meshopt-compressed GLB and
 * reports the model ready (the globe mirrors the state on `sim-view` as data-sim-model /
 * data-sim-model-state). With the file blocked, the state goes to "failed" and the view keeps running
 * (the marker stays; its pixels are not asserted). Not proved: how the model looks. CI's Chromium
 * renders WebGL in software and the Esri tiles are blocked here (as in sim.spec.ts) to keep it light.
 */

import { expect, type Page, test } from './fixtures'

const MODEL_REQUEST = /\/models\/sim\/[a-z-]+\.glb$/
const AIRCRAFT_CLASSES = /^(airliner|widebody|turboprop|twin-prop|light-single|bizjet|helicopter)$/

async function openCockpit(page: Page, list: RegExp | string, detailButton: string) {
  await page.route(/arcgis(online)?\.com/, (route) => route.abort())
  await page.goto('/list')
  const row = typeof list === 'string' ? page.locator(list).first() : page.getByTestId(list).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await page.getByTestId(detailButton).click()
  await expect(page.getByTestId('sim-view').locator('canvas')).toBeVisible({ timeout: 30_000 })
}

test('the outside view loads the followed aircraft’s 3D model, only once switched on', async ({ page }) => {
  const requested: string[] = []
  page.on('request', (r) => {
    if (MODEL_REQUEST.test(r.url())) requested.push(r.url())
  })
  await openCockpit(page, '[data-testid^="list-ac-"]', 'detail-cockpit')
  const view = page.getByTestId('sim-view')

  // The class is known from the aircraft's type / category, but nothing is fetched in the cockpit camera.
  await expect(view).toHaveAttribute('data-sim-model', AIRCRAFT_CLASSES, { timeout: 15_000 })
  await expect(view).toHaveAttribute('data-sim-model-state', 'off')
  const cls = (await view.getAttribute('data-sim-model')) as string
  expect(requested).toEqual([])

  const answer = page.waitForResponse((r) => MODEL_REQUEST.test(r.url()), { timeout: 30_000 })
  await page.getByTestId('sim-camera-toggle').click()
  await expect(view).toHaveAttribute('data-camera', 'chase')
  const res = await answer
  expect(res.status()).toBe(200)
  expect(res.url()).toMatch(new RegExp(`/models/sim/${cls}\\.glb$`))
  expect((await res.body()).subarray(0, 4).toString('ascii')).toBe('glTF')

  await expect(view).toHaveAttribute('data-sim-model-state', 'ready', { timeout: 30_000 })

  // Back to the cockpit camera and out again: the model is kept, not fetched a second time.
  await page.getByTestId('sim-camera-toggle').click()
  await expect(view).toHaveAttribute('data-camera', 'cockpit')
  await page.getByTestId('sim-camera-toggle').click()
  await expect(view).toHaveAttribute('data-sim-model-state', 'ready')
  expect(requested).toHaveLength(1)
})

test('without the model file the outside view keeps the marker and keeps running', async ({ page }) => {
  await page.route(MODEL_REQUEST, (route) => route.abort())
  await openCockpit(page, '[data-testid^="list-ac-"]', 'detail-cockpit')
  const view = page.getByTestId('sim-view')
  await expect(view).toHaveAttribute('data-sim-model', AIRCRAFT_CLASSES, { timeout: 15_000 })

  await page.getByTestId('sim-camera-toggle').click()
  await expect(view).toHaveAttribute('data-camera', 'chase')
  await expect(view).toHaveAttribute('data-sim-model-state', 'failed', { timeout: 30_000 })

  // The view is still alive: the camera follows and the HUD updates.
  await expect(page.getByTestId('sim-status')).toHaveText(/Live|Data \d+ s old/, { timeout: 30_000 })
  await expect(page.getByTestId('sim-heading')).toHaveText(/^\d+°$/)
  await expect(view.locator('canvas')).toBeVisible()
})

test('a followed satellite gets the satellite model in the outside view', async ({ page }) => {
  await openCockpit(page, /^list-sat-\d+$/, 'sat-cockpit')
  const view = page.getByTestId('sim-view')
  await expect(view).toHaveAttribute('data-sim-model', 'satellite', { timeout: 15_000 })

  await page.getByTestId('sim-camera-toggle').click()
  await expect(view).toHaveAttribute('data-sim-model-state', 'ready', { timeout: 30_000 })
})
