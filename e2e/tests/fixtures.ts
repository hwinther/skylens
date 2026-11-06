import { guardsTest } from '@wshno/playwright-config'

export { expect, type Page } from '@playwright/test'

/** zustand persist key of app/src/state/settingsStore.ts. */
const SETTINGS_KEY = 'skylens.settings.v1'

/**
 * Every spec runs under the shared guards from @wshno/playwright-config. cspGuard fails a spec on any
 * CSP violation, Report-Only included: in container mode the backend serves the production bundle with
 * the real policy (backend/src/Api/Security/SecurityHeaders.cs). The console and request guards start
 * in warn mode: React Native Web logs deprecation warnings, and the OpenStreetMap tiles depend on the
 * runner's internet access. They annotate the report until that is sorted out, then move to fail.
 *
 * `onboarded` (default true) marks first-run onboarding as done before the app loads, so a fresh
 * browser lands on the page under test instead of /onboarding. Onboarding's own spec turns it off.
 */
export const test = guardsTest.extend<{ onboarded: boolean }>({
  consoleGuard: { mode: 'warn' },
  requestGuard: { mode: 'warn' },
  onboarded: [true, { option: true }],
  page: async ({ page, onboarded }, use) => {
    if (onboarded) {
      await page.addInitScript((key) => {
        const stored = JSON.parse(localStorage.getItem(key) ?? 'null') as {
          state?: Record<string, unknown>
          version?: number
        } | null
        if (stored?.state?.onboarded === true) return
        localStorage.setItem(
          key,
          JSON.stringify({ state: { ...stored?.state, onboarded: true }, version: stored?.version ?? 0 }),
        )
      }, SETTINGS_KEY)
    }
    await use(page)
  },
})
