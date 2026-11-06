/**
 * Routes without a tab button must stay reachable. expo-router 58 turns `href: null` into a hidden
 * route that redirects to "/", which silently broke first-run onboarding, the sign-in screen and the
 * web OAuth popup's /oauth landing page. _layout.tsx now hides only the tab button.
 */

import { expect, test } from './fixtures'

test.describe('first run', () => {
  test.use({ onboarded: false })

  test('a fresh browser gets onboarding, and Skip lands on the AR view', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/onboarding$/)
    await expect(page.getByText('Welcome to Skylens')).toBeVisible()

    await page.getByText('Skip', { exact: true }).click()
    await expect(page).not.toHaveURL(/\/onboarding/)
    await expect(page.getByTestId('status-aircraft-count')).toBeVisible()

    // Done once: a reload stays on the app.
    await page.reload()
    await expect(page.getByTestId('status-aircraft-count')).toBeVisible()
    await expect(page).not.toHaveURL(/\/onboarding/)
  })
})

test('the sign-in screen is reachable', async ({ page }) => {
  await page.goto('/sign-in')
  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(page.getByText("Point at the sky. See what's flying.")).toBeVisible()
})

test('the OAuth redirect page is reachable', async ({ page }) => {
  await page.goto('/oauth')
  await expect(page).toHaveURL(/\/oauth$/)
  await expect(page.getByText('Completing sign-in…')).toBeVisible()
})

test('hidden routes have no tab button', async ({ page }) => {
  await page.goto('/list')
  const tabs = page.getByRole('tab')
  await expect(tabs.filter({ visible: true })).toHaveCount(4)
})
