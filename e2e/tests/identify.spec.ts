/**
 * AR identify ("what am I looking at?") on web, against the real backend and the committed GeoNames
 * landmarks file (Development reads data/landmarks/landmarks.csv.gz; the image bakes it). The app is
 * in live mode at the fixture home (Oslo TMA), facing east 20° up, with the synthetic horizon drawn
 * (no camera on desktop web).
 *
 * - The viewfinder toggle is a switch: pressing it shows the reticle and fetches the area's landmarks
 *   once (GET /api/landmarks, slim DTOs + the GeoNames attribution).
 * - Press-and-hold on the horizon identifies the point under the pointer: a result card plus a laser
 *   beam. Which landmark sits there depends on the dataset, so the sweep below only requires that SOME
 *   named landmark turns up while turning; the match itself is unit-tested in app/__tests__.
 */

import { dragView, freePoint, openArAtHorizon } from './arView'
import { expect, type Page, test } from './fixtures'

/**
 * Hold the primary button still until the long-press result shows, then release. Any card already open
 * is closed first: on a slow page a drag can stall long enough to count as a hold, and its card must not
 * be mistaken for this press's answer.
 */
async function pressAndHold(page: Page, x: number, y: number) {
  const close = page.getByTestId('ar-identify-close')
  if (await close.isVisible()) await close.click()
  await expect(page.getByTestId('ar-identify-result')).toHaveCount(0)
  // A detail card (a label's release) would suppress the identify card.
  await expect(page.getByTestId('detail-card')).toHaveCount(0)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await expect(page.getByTestId('ar-identify-result')).toBeVisible({ timeout: 5_000 })
  await page.mouse.up()
}

test('viewfinder toggle fetches the landmarks once and shows the reticle', async ({ page }) => {
  await page.goto('/')
  const toggle = page.getByTestId('ar-identify-toggle')
  await expect(toggle).toBeVisible({ timeout: 30_000 })
  await expect(toggle).toHaveAttribute('role', 'switch')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/landmarks')
  await toggle.click()
  const res = await response
  expect(res.status()).toBe(200)
  const body = (await res.json()) as {
    attribution: string
    landmarks: { id: string; kind: string; name: string; lat: number; lon: number }[]
  }
  expect(body.attribution).toContain('GeoNames')
  expect(body.landmarks.length).toBeGreaterThan(100)
  for (const l of body.landmarks.slice(0, 50)) {
    expect(['peak', 'city', 'town', 'village', 'hamlet']).toContain(l.kind)
    expect(l.name.length).toBeGreaterThan(0)
  }

  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('ar-identify-reticle')).toBeVisible()
  await expect(page.getByTestId('ar-identify-result')).toBeVisible()

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId('ar-identify-reticle')).toHaveCount(0)
})

test('press-and-hold on the horizon names a landmark with a laser beam, and closes', async ({ page }) => {
  await openArAtHorizon(page)
  const box = (await page.locator('body').boundingBox())!
  const cy = box.y + box.height / 2
  const horizon = page.getByTestId('ar-horizon')

  const name = page.getByTestId('ar-identify-name')
  let found = ''
  // Turn ~24° per step until a press on the horizon lands on a named landmark (villages near Oslo are
  // dense, so this normally succeeds at once); the asserts after the loop are unconditional.
  /* eslint-disable playwright/no-conditional-in-test */
  // The first hold triggers the lazy landmarks fetch (checked after the sweep).
  const landmarks = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/landmarks')
  for (let i = 0; i < 15 && !found; i++) {
    const h = (await horizon.boundingBox())!
    const at = await freePoint(page, h.y + 2)
    await pressAndHold(page, at.x, at.y)
    // Settled: a name, or "Nothing named…" (not still loading, not "Landmarks unavailable").
    await expect(name).not.toHaveText(/Looking up landmarks|Landmarks unavailable/)
    const text = ((await name.textContent()) ?? '').trim()
    if (!/^Nothing named/.test(text)) found = text
    else {
      await page.getByTestId('ar-identify-close').click()
      await dragView(page, cy, -160, 0)
    }
  }
  /* eslint-enable playwright/no-conditional-in-test */
  expect((await landmarks).status()).toBe(200)
  expect(found, 'a sweep along the horizon should name at least one landmark').not.toBe('')

  const card = page.getByTestId('ar-identify-result')
  await expect(card).toContainText('GeoNames (CC BY 4.0)')
  await expect(card).toHaveAttribute('aria-label', new RegExp(found.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  await expect(page.getByTestId('ar-identify-beam')).toBeVisible()

  await page.getByTestId('ar-identify-close').click()
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('ar-identify-beam')).toHaveCount(0)
})
