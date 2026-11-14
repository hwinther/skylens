/**
 * The cockpit view's window frame (src/sim/cockpitFrame.ts, components/SimCockpitFrame.web.tsx): a
 * generic aeroplane / helicopter / bridge frame drawn as SVG over the globe in the cockpit camera, on
 * by default, hidden with the "Frame" chip (remembered), absent in the outside view, sliding opposite
 * to the look offset, and never in the way of a tap or a drag.
 *
 * The aircraft are the replay fixture's (backend/tests/Api.Tests/fixtures/aircraft.json): 4aca79 is an
 * A3 airliner and 478df1 an A7 rotorcraft (the source-mode backend has no aircraft DB, so no `t`; the
 * emitter category decides). Like sim.spec.ts, the Esri imagery is blocked (software WebGL in CI) and
 * gestures are dispatched as pointer events, but here on whatever element is really under the point
 * (document.elementFromPoint), so a frame post that swallowed input would fail the test.
 */

import { expect, type Page, test } from './fixtures'

const PLANE_HEX = '4aca79'
const HELI_HEX = '478df1'

async function openCockpit(page: Page, hex: string) {
  await page.route(/arcgis(online)?\.com/, (route) => route.abort())
  await page.goto(`/sim?kind=aircraft&id=${hex}`)
  await expect(page.getByTestId('sim-view').locator('canvas')).toBeVisible({ timeout: 30_000 })
}

/** Whether the element really under (x, y) belongs to the globe's view (not the frame). */
async function globeUnder(page: Page, x: number, y: number): Promise<boolean> {
  return page.evaluate(
    ({ px, py }) => {
      const hit = document.elementFromPoint(px, py)
      return !!hit?.closest('[data-testid="sim-view"]')
    },
    { px: x, py: y },
  )
}

/** A drag from (x0, y0) by (dx, dy), dispatched on the element under the start point. */
async function dragFrom(page: Page, x0: number, y0: number, dx: number, dy: number) {
  await page.evaluate(
    ({ sx, sy, ddx, ddy }) => {
      const target = document.elementFromPoint(sx, sy)
      if (!target) throw new Error('nothing under the start point')
      const send = (type: string, x: number, y: number) =>
        target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true }))
      send('pointerdown', sx, sy)
      for (let i = 1; i <= 8; i++) send('pointermove', sx + (ddx * i) / 8, sy + (ddy * i) / 8)
      send('pointerup', sx + ddx, sy + ddy)
    },
    { sx: x0, sy: y0, ddx: dx, ddy: dy },
  )
}

test('the frame shows by default with the aircraft\'s variant; the Frame chip hides it and a reload remembers', async ({ page }) => {
  await openCockpit(page, PLANE_HEX)
  const frame = page.getByTestId('sim-frame')
  await expect(frame).toBeVisible({ timeout: 30_000 })
  await expect(frame).toHaveAttribute('data-variant', 'aeroplane')
  await expect(page.getByTestId('sim-frame-aeroplane')).toBeVisible()
  // It never takes input.
  await expect(frame).toHaveCSS('pointer-events', 'none')

  const toggle = page.getByTestId('sim-frame-toggle')
  await expect(toggle).toHaveAttribute('role', 'button')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(frame).toHaveCount(0)
  const stored = await page.evaluate(() => localStorage.getItem('skylens.settings.v1') ?? '')
  expect(JSON.parse(stored).state.simCockpitFrame).toBe(false)

  await page.reload()
  await expect(page.getByTestId('sim-view').locator('canvas')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('sim-frame-toggle')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('sim-frame')).toHaveCount(0)

  await page.getByTestId('sim-frame-toggle').click()
  await expect(page.getByTestId('sim-frame-aeroplane')).toBeVisible()
})

test('a rotorcraft gets the helicopter canopy', async ({ page }) => {
  await openCockpit(page, HELI_HEX)
  await expect(page.getByTestId('sim-frame')).toHaveAttribute('data-variant', 'helicopter', { timeout: 30_000 })
  await expect(page.getByTestId('sim-frame-helicopter')).toBeVisible()
})

test('the outside view has no frame and no Frame chip', async ({ page }) => {
  await openCockpit(page, PLANE_HEX)
  await expect(page.getByTestId('sim-frame')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('sim-camera-toggle').click()
  await expect(page.getByTestId('sim-view')).toHaveAttribute('data-camera', 'chase')
  await expect(page.getByTestId('sim-frame')).toHaveCount(0)
  await expect(page.getByTestId('sim-frame-toggle')).toHaveCount(0)

  await page.getByTestId('sim-camera-toggle').click()
  await expect(page.getByTestId('sim-frame-aeroplane')).toBeVisible()
  await expect(page.getByTestId('sim-frame-toggle')).toHaveAttribute('aria-pressed', 'true')
})

test('a drag that starts on a frame post looks around, and the frame slides the other way', async ({ page }) => {
  await openCockpit(page, PLANE_HEX)
  const layer = page.getByTestId('sim-frame-aeroplane')
  await expect(layer).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('detail-card-close').click()

  // The aeroplane's centre post stands right of the view's centre (the left seat's view): find it from
  // the drawn frame (the pane edge nearest to the middle), then check the globe is what's under it.
  const viewport = page.viewportSize() as { width: number; height: number }
  const post = { x: viewport.width / 2 + Math.min(200, Math.max(50, 0.16 * viewport.width)), y: viewport.height * 0.4 }
  expect(await globeUnder(page, post.x, post.y)).toBe(true)

  const before = (await layer.boundingBox()) as { x: number; y: number }
  // Drag left and down from the post = look right and up.
  await dragFrom(page, post.x, post.y, -260, 130)
  await expect(page.getByTestId('sim-look-offset')).toHaveText(/right · \d+° up$/)
  await expect
    .poll(async () => {
      const box = (await layer.boundingBox()) as { x: number; y: number }
      return box.x < before.x - 20 && box.y > before.y + 10
    })
    .toBe(true)

  // Recenter puts it back.
  await page.getByTestId('sim-recenter').click()
  await expect
    .poll(async () => {
      const box = (await layer.boundingBox()) as { x: number; y: number }
      return Math.abs(box.x - before.x) < 1 && Math.abs(box.y - before.y) < 1
    })
    .toBe(true)
})

interface PlaceOnScreen {
  key: string
  group: string
  x: number
  y: number
}

/** The airport points on screen now (from the globe's test hook), clear of the edges. */
async function airportsOnScreen(page: Page): Promise<PlaceOnScreen[]> {
  return page.getByTestId('sim-view').evaluate((el) => {
    const hook = (el as HTMLElement & { skylensSimPlaces?: () => PlaceOnScreen[] }).skylensSimPlaces
    const rect = el.getBoundingClientRect()
    return (hook?.() ?? []).filter(
      (p) => p.group === 'airports' && p.x > 40 && p.x < rect.width - 40 && p.y > 40 && p.y < rect.height - 40,
    )
  })
}

/** An airport point on screen within `ms`, or null. */
async function airportWithin(page: Page, ms: number): Promise<PlaceOnScreen | null> {
  try {
    await expect.poll(async () => (await airportsOnScreen(page)).length, { timeout: ms }).toBeGreaterThan(0)
  } catch {
    return null
  }
  return (await airportsOnScreen(page))[0] ?? null
}

/** An airport point on screen: straight ahead first, then in 45° steps to the right (a 300 px drag). */
async function findAirport(page: Page): Promise<PlaceOnScreen | null> {
  let place = await airportWithin(page, 15_000)
  for (let turn = 1; turn < 8 && !place; turn++) {
    await dragFrom(page, 600, 300, -300, 0)
    place = await airportWithin(page, 3_000)
  }
  return place
}

test('a tap on an airport through the frame still opens its place card', async ({ page }) => {
  const airportsAnswer = page.waitForResponse((r) => /\/api\/airports\?/.test(r.url()) && r.ok(), { timeout: 60_000 })
  await openCockpit(page, PLANE_HEX)
  await airportsAnswer
  await expect(page.getByTestId('sim-frame')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('detail-card-close').click()

  // The frame's solids (glareshield, a pillar) let the globe through too.
  const viewport = page.viewportSize() as { width: number; height: number }
  expect(await globeUnder(page, viewport.width * 0.3, viewport.height - 30)).toBe(true)

  // An airport on screen, looking around in 45° steps if none is ahead.
  const place = await findAirport(page)
  expect(place, 'an airport point on screen in some direction').not.toBeNull()
  const at = place as PlaceOnScreen
  const rect = (await page.getByTestId('sim-view').boundingBox()) as { x: number; y: number }
  const x = rect.x + at.x
  const y = rect.y + at.y
  expect(await globeUnder(page, x, y)).toBe(true)

  // Tap it on whatever is under the point (the frame is drawn over the whole view).
  await page.evaluate(
    ({ px, py }) => {
      const target = document.elementFromPoint(px, py) as Element
      const init = { clientX: px, clientY: py, pointerId: 2, pointerType: 'mouse', bubbles: true }
      target.dispatchEvent(new PointerEvent('pointerdown', init))
      target.dispatchEvent(new PointerEvent('pointerup', init))
    },
    { px: x, py: y },
  )
  await expect(page.getByTestId('sim-place-card')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('sim-place-kind')).toContainText(/airport/i)
})
