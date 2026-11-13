/**
 * List tab filter bar + accordion against the replayed backend feed: the Sea chip hides the ship rows
 * while the aircraft stay, a section heading collapses its rows, and both choices survive a reload
 * (persisted in the settings store, localStorage on web). The rules themselves are unit-tested in the
 * app (listFilter.test.ts, ListFilter.native.test.tsx); this proves the web wiring end to end.
 */

import { expectAccessible } from '@wshno/playwright-config'

import { expect, test } from './fixtures'

test('the filter chips and section headings persist across a reload', async ({ page }) => {
  await page.goto('/list')

  const shipRows = page.locator('[data-testid^="list-ship-"]')
  const aircraftRows = page.locator('[data-testid^="list-ac-"]')
  await expect(shipRows.first(), 'the AIS replay should list a ship').toBeVisible({ timeout: 30_000 })
  await expect(aircraftRows.first(), 'the ADS-B replay should list an aircraft').toBeVisible({ timeout: 30_000 })

  // Hide Sea: a toggle button that reports its state, ship rows gone, aircraft still listed.
  const sea = page.getByTestId('list-filter-sea')
  await expect(sea).toHaveAttribute('role', 'button')
  await expect(sea).toHaveAttribute('aria-pressed', 'true')
  await sea.click()
  await expect(sea).toHaveAttribute('aria-pressed', 'false')
  await expect(shipRows).toHaveCount(0)
  await expect(aircraftRows.first()).toBeVisible()
  await expect(page.getByTestId('list-section-traffic')).not.toContainText('sea')

  // Collapse Traffic: its rows go, the heading and its count stay.
  const traffic = page.getByTestId('list-section-traffic')
  await expect(traffic).toHaveAttribute('aria-expanded', 'true')
  await traffic.click()
  await expect(traffic).toHaveAttribute('aria-expanded', 'false')
  await expect(aircraftRows).toHaveCount(0)
  await expect(page.getByTestId('list-count')).toHaveText(/^Traffic \(\d+\)$/)

  // Both choices come back after a reload.
  await page.reload()
  await expect(page.getByTestId('list-filter-sea')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('list-section-traffic')).toHaveAttribute('aria-expanded', 'false')
  await expect(aircraftRows).toHaveCount(0)

  // Expanding again lists aircraft only: Sea is still filtered out.
  await page.getByTestId('list-section-traffic').click()
  await expect(aircraftRows.first()).toBeVisible({ timeout: 30_000 })
  await expect(shipRows).toHaveCount(0)
})

// axe (WCAG 2.x A/AA) on the list with the replayed traffic in it: fails on serious or critical violations.
test('the list is accessible', async ({ page }) => {
  await page.goto('/list')
  await expect(page.locator('[data-testid^="list-ac-"]').first()).toBeVisible({ timeout: 30_000 })
  await expectAccessible(page)
})
