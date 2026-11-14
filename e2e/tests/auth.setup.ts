/**
 * Signs the e2e user in on a deployed env (BASE_URL, the nightly preview), once per run.
 *
 * Only playwright.ci.config.ts with BASE_URL set runs this (its `setup` project); the compose run uses
 * DevAuth and never signs in. A preview host has two gates, and the user passes both:
 *  1. Authelia forward-auth on the host: the first navigation lands on auth.wsh.no for the password and
 *     TOTP, then comes back to the app.
 *  2. The app's own OIDC sign-in (real JwtBearer in previews): the sign-in card's button opens a popup
 *     to auth.wsh.no, which already has the session from step 1 but always asks for consent, because
 *     the skylens client requests offline_access. "Accept" sends the popup back to /oauth.
 *
 * The result is saved as storage state: Authelia's session cookie plus the app's session in
 * localStorage. The chromium project loads it, so every spec starts signed in.
 */

import { expect, test as setup } from '@playwright/test'
import * as OTPAuth from 'otpauth'
import { authFile } from './auth-paths'

/** zustand persist key of app/src/state/settingsStore.ts (as in fixtures.ts). */
const SETTINGS_KEY = 'skylens.settings.v1'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set to sign in on a deployed env`)
  return value
}

setup('authenticate', async ({ page, baseURL }) => {
  const username = requiredEnv('E2E_USERNAME')
  const password = requiredEnv('E2E_PASSWORD')
  const otpSecret = requiredEnv('E2E_OTP_SECRET')
  const appHost = new URL(baseURL ?? '').hostname

  // A fresh browser is routed to onboarding first; mark it done so "/" shows the sign-in card.
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ state: { onboarded: true }, version: 0 }))
  }, SETTINGS_KEY)

  // 1. Forward-auth: unauthenticated, the host redirects to Authelia.
  await page.goto('/')
  await page.waitForURL(/auth\.wsh\.no/, { timeout: 15_000 })
  await page.getByRole('textbox', { name: /username/i }).fill(username)
  await page.locator('input[type="password"]').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/auth\.wsh\.no\/2fa/, { timeout: 10_000 })

  // Generated just before typing, so a slow login can't leave a stale code. Authelia renders one input
  // per digit inside #otp-input; type into the first and it advances and submits by itself.
  const code = new OTPAuth.TOTP({ secret: otpSecret, digits: 6, period: 30 }).generate()
  const otpInputs = page.locator('#otp-input').getByRole('textbox')
  await expect(otpInputs).toHaveCount(code.length)
  await otpInputs.first().click()
  await page.keyboard.type(code)
  await page.waitForURL((url) => url.hostname === appHost, { timeout: 15_000 })

  // 2. The app's sign-in: the popup goes to auth.wsh.no's consent page, then back to /oauth.
  const signIn = page.getByTestId('signin-prompt-signin')
  await expect(signIn).toBeEnabled({ timeout: 30_000 })
  const popupOpened = page.waitForEvent('popup')
  await signIn.click()
  const popup = await popupOpened
  await popup.waitForURL(/auth\.wsh\.no\/consent/, { timeout: 15_000 })
  await popup.getByRole('button', { name: 'Accept' }).click()
  await expect(page.getByTestId('signin-prompt')).toBeHidden({ timeout: 30_000 })

  await page.context().storageState({ path: authFile })
})
