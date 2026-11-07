/**
 * A failing REST call must be visible to the user, not just an empty layer: an expired session used to
 * leave airports / ports / satellites blank (401) while the hub still said "connected".
 */

import { expect, test } from './fixtures'

test('a 401 from a layer endpoint shows the session banner, and dismiss hides it', async ({ page }) => {
  // Pass the request through and only swap the status, so the backend's own headers (the X-Skylens-Api
  // marker + CORS in source mode) stay intact: this is a 401 from the API itself, not an edge block.
  await page.route('**/api/airports**', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, status: 401, body: '{}' })
  })

  await page.goto('/map')
  await page.getByTestId('map-view-map').click()

  const banner = page.getByTestId('api-issue-banner')
  await expect(banner).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('api-issue-text')).toContainText('Session expired')
  await expect(page.getByTestId('api-issue-text')).toContainText('airports (401)')
  await page.screenshot({ path: test.info().outputPath('api-issue-banner.png') })

  await page.getByTestId('api-issue-dismiss').click()
  await expect(banner).toBeHidden()
})
