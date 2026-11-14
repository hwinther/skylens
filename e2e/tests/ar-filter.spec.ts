/**
 * The AR view's layer filter on web: the Layers button (`ar-filter`) unfolds one chip per group that is
 * on in Settings. Hiding Aircraft removes every aircraft label and edge arrow while the other groups
 * (airport labels on the horizon) keep drawing, badges the button, survives a reload (persisted in
 * settingsStore), and "Show all" (`ar-filter-reset`) brings the aircraft back. The feed itself is
 * untouched: the status strip still counts the replayed aircraft.
 */

import { dragView, openArAtHorizon, settledAirports } from './arView'
import { expect, type Page, test } from './fixtures'

/** Aircraft the overlay draws: labels in view plus edge arrows for the ones outside it. */
const aircraftDrawn = (page: Page) => page.locator('[data-testid^="ac-label-"], [data-testid^="ac-arrow-"]')

test('hiding aircraft in AR removes only them, survives a reload, and Show all brings them back', async ({ page }) => {
  await openArAtHorizon(page)
  // Turn north, toward the airports north of the fixture home (as ar-label-tap does).
  const body = (await page.locator('body').boundingBox())!
  const cy = body.y + body.height / 2
  await dragView(page, cy, -300, 0)
  await dragView(page, cy, -300, 0)
  await expect(page.getByTestId('status-aircraft-count')).toHaveText(/[1-9]/)
  await expect(aircraftDrawn(page).first()).toBeAttached()
  expect((await settledAirports(page)).length).toBeGreaterThan(0)

  const button = page.getByTestId('ar-filter')
  await expect(button).toHaveAttribute('aria-label', 'Layers')
  await expect(page.getByTestId('ar-filter-badge')).toHaveCount(0)
  await button.click()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  const chip = page.getByTestId('ar-filter-aircraft')
  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  // Groups on by default in Settings have chips too.
  await expect(page.getByTestId('ar-filter-airports')).toBeVisible()
  await expect(page.getByTestId('ar-filter-vessels')).toBeVisible()

  await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', 'false')
  await expect(aircraftDrawn(page)).toHaveCount(0)
  await expect(page.getByTestId('ar-filter-badge')).toHaveText('1')
  await expect(button).toHaveAttribute('aria-label', 'Layers, 1 hidden')
  // Other groups keep drawing, and the feed is untouched.
  expect((await settledAirports(page)).length).toBeGreaterThan(0)
  await expect(page.getByTestId('status-aircraft-count')).toHaveText(/[1-9]/)

  await page.reload()
  await expect(page.getByTestId('ar-identify-toggle')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('status-aircraft-count')).toHaveText(/[1-9]/)
  await expect(page.getByTestId('ar-filter-badge')).toHaveText('1')
  // The replay keeps arriving; still nothing drawn for aircraft.
  await expect(page.getByTestId('compass-N').or(page.getByTestId('compass-E'))).toBeVisible()
  await expect(aircraftDrawn(page)).toHaveCount(0)

  await page.getByTestId('ar-filter').click()
  await expect(page.getByTestId('ar-filter-aircraft')).toHaveAttribute('aria-pressed', 'false')
  await page.getByTestId('ar-filter-reset').click()
  await expect(page.getByTestId('ar-filter-aircraft')).toHaveAttribute('aria-pressed', 'true')
  await expect(aircraftDrawn(page).first()).toBeAttached()
  await expect(page.getByTestId('ar-filter-badge')).toHaveCount(0)
})
