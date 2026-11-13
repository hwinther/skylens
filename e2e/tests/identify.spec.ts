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

import { expect, type Page, test } from './fixtures'

/**
 * A point on the row at height `y` that belongs to the bare view: identify's long-press catcher, not a
 * label. Airport labels sit right on the horizon and replayed aircraft drift across the sky; they are
 * tap targets above the catcher, so a hold on one never reaches identify, and a drag that starts on one
 * can end in a click that opens its detail card (which hides the identify card). Where they are depends
 * on the replay's timing, so search outward from the middle for a free spot, with a margin around it.
 *
 * The overlay redraws at ~20 fps, so right after a drag the labels can still be where the old pose put
 * them. Only trust a pick once the overlay has caught up: the compass marks and airport labels are fixed
 * on the sky, so their positions stop changing exactly when the drawn pose matches the dragged one.
 */
async function freePoint(page: Page, y: number): Promise<{ x: number; y: number }> {
  let previousLayout: string | null = null
  let x: number | null = null
  await expect(async () => {
    const sample = await page.evaluate(
      async ({ y, margin }) => {
        // Sample after the overlay has had at least two more draws (it runs at ~20 fps).
        const t0 = performance.now()
        await new Promise<void>((done) => {
          const frame = () => (performance.now() - t0 >= 120 ? done() : requestAnimationFrame(frame))
          requestAnimationFrame(frame)
        })
        const layout = [...document.querySelectorAll('[data-testid^="compass-"], [data-testid^="ar-airport-"]')]
          .map((el) => {
            const r = el.getBoundingClientRect()
            return `${el.getAttribute('data-testid')}@${Math.round(r.left)},${Math.round(r.top)}`
          })
          .sort()
          .join(';')
        const owner = (px: number, py: number) =>
          document.elementFromPoint(px, py)?.closest('[data-testid]')?.getAttribute('data-testid')
        const around: [number, number][] = [
          [0, 0],
          [-margin, 0],
          [margin, 0],
          [0, -margin],
          [0, margin],
        ]
        const free = (px: number) => around.every(([dx, dy]) => owner(px + dx, y + dy) === 'ar-identify-touch')
        const mid = window.innerWidth / 2
        for (let d = 0; d < mid - margin; d += 8) {
          if (free(mid + d)) return { layout, x: mid + d }
          if (free(mid - d)) return { layout, x: mid - d }
        }
        return { layout, x: null }
      },
      { y, margin: 24 },
    )
    const settled = sample.layout === previousLayout
    previousLayout = sample.layout
    x = sample.x
    expect(settled, 'the overlay should have caught up with the pose').toBe(true)
    expect(x, `some stretch of the row at y=${y} should be free of labels`).not.toBeNull()
  }).toPass({ timeout: 10_000, intervals: [0] })
  return { x: x!, y }
}

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
  await page.goto('/')
  await expect(page.getByTestId('ar-identify-toggle')).toBeVisible({ timeout: 30_000 })

  const box = (await page.locator('body').boundingBox())!
  const cy = box.y + box.height / 2
  // Drag-to-look from a free point on row `y` (see freePoint) by (dx, dy).
  const drag = async (y: number, dx: number, dy: number) => {
    const from = await freePoint(page, y)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(Math.max(1, from.x + dx), from.y + dy, { steps: 12 })
    await page.mouse.up()
  }
  // Bring the horizon toward the middle of the view (the start pose looks 20° up).
  await drag(cy - 60, 0, 120)
  const horizon = page.getByTestId('ar-horizon')
  await expect(horizon).toBeVisible()

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
      await drag(cy, -160, 0)
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
