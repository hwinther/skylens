/**
 * Turning the Radar around the observer on web, against the real backend (replayed aircraft, the
 * committed ETOPO terrain grids). The observer stays at the centre; only the view bearing changes.
 *
 * - North up by default: no "north up" button.
 * - A horizontal drag on the scope turns it: the N mark moves round the rim and the north-up button
 *   appears. A drag that starts on a blip does not open its card.
 * - The north-up button puts the N mark back where it was and goes away again.
 * - Tilted, the relief turns with the scope and stays drawn.
 *
 * Positions are compared loosely (the N mark moves tens of px; "back" means within a couple of px), never
 * pixel-exact.
 */

import { expect, test, type Page } from './fixtures'

async function centreOf(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox()
  expect(box).not.toBeNull()
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
}

/** A horizontal mouse drag in small steps (the gesture handler needs intermediate moves). */
async function dragX(page: Page, from: { x: number; y: number }, dx: number) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  const steps = 12
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + (dx * i) / steps, from.y)
  await page.mouse.up()
}

test('a horizontal drag turns the radar around the observer; north up resets it', async ({ page }) => {
  await page.goto('/map')
  await page.getByTestId('map-view-radar').click()
  const radar = page.getByTestId('radar')
  const blip = radar.locator('[data-testid^="map-ac-"]').first()
  await expect(blip).toBeVisible({ timeout: 30_000 })
  // A fixed range, so the auto range can't rescale the scope while the replayed traffic moves.
  await page.getByTestId('radar-zoom-in').click()

  await expect(page.getByTestId('radar-north-up')).toHaveCount(0)
  const n0 = await centreOf(page, 'radar-cardinal-n')
  const scope = await centreOf(page, 'radar-scope')

  // Start the drag on a blip: the scope turns, but the blip's card must not open on release.
  const start = await blip.boundingBox()
  expect(start).not.toBeNull()
  await dragX(page, { x: start!.x + start!.width / 2, y: start!.y + start!.height / 2 }, 160)

  const northUp = page.getByTestId('radar-north-up')
  await expect(northUp).toBeVisible()
  await expect(northUp).toHaveAttribute('aria-label', 'North up')
  await expect(page.getByTestId('detail-card')).toHaveCount(0)
  const n1 = await centreOf(page, 'radar-cardinal-n')
  expect(Math.hypot(n1.x - n0.x, n1.y - n0.y)).toBeGreaterThan(30)
  // The picture follows the finger: dragged right, the N mark (at the top) swings right.
  expect(n1.x).toBeGreaterThan(n0.x)
  // It stays on the rim around the same centre (the observer doesn't move).
  const r0 = Math.hypot(n0.x - scope.x, n0.y - scope.y)
  const r1 = Math.hypot(n1.x - scope.x, n1.y - scope.y)
  expect(Math.abs(r1 - r0)).toBeLessThan(r0 * 0.15)

  // Blips stay tappable on the turned scope (a tap right after a drag's release is briefly ignored, so retry).
  await expect(async () => {
    await blip.click()
    await expect(page.getByTestId('detail-card')).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 10_000 })
  await page.getByTestId('detail-card-close').click()

  // North up: the N mark returns and the button goes away.
  await northUp.click()
  await expect(page.getByTestId('radar-north-up')).toHaveCount(0)
  const n2 = await centreOf(page, 'radar-cardinal-n')
  expect(Math.abs(n2.x - n0.x)).toBeLessThan(2)
  expect(Math.abs(n2.y - n0.y)).toBeLessThan(2)

  // Tilted, the relief turns with the scope and stays drawn; north up resets it again.
  await page.getByTestId('radar-tilt').click()
  await expect(page.getByTestId('radar-terrain')).toHaveCount(1, { timeout: 30_000 })
  const t0 = await centreOf(page, 'radar-cardinal-n')
  const terrainBefore = await page.getByTestId('radar-terrain').innerHTML()
  await dragX(page, { x: scope.x - 120, y: scope.y + 20 }, -200)
  await expect(page.getByTestId('radar-north-up')).toBeVisible()
  await expect(page.getByTestId('radar-terrain')).toHaveCount(1)
  const t1 = await centreOf(page, 'radar-cardinal-n')
  expect(Math.hypot(t1.x - t0.x, t1.y - t0.y)).toBeGreaterThan(30)
  expect(await page.getByTestId('radar-terrain').innerHTML()).not.toEqual(terrainBefore)
  await page.getByTestId('radar-north-up').click()
  await expect(page.getByTestId('radar-north-up')).toHaveCount(0)
  const t2 = await centreOf(page, 'radar-cardinal-n')
  expect(Math.abs(t2.x - t0.x)).toBeLessThan(2)
  expect(Math.abs(t2.y - t0.y)).toBeLessThan(2)
})
