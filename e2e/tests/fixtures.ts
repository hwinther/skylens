import type { TestInfo } from '@playwright/test'
import { guardsTest } from '@wshno/playwright-config'
import { addCoverageReport } from 'monocart-reporter'

export { expect, type Page } from '@playwright/test'

/** zustand persist key of app/src/state/settingsStore.ts. */
const SETTINGS_KEY = 'skylens.settings.v1'

/**
 * Browser JS coverage is collected only when the run has the monocart reporter, i.e. under
 * playwright.ci.config.ts (container mode). Plain `npm test` (source mode, Metro dev server) skips the
 * CDP round trip and the per-test attachment.
 */
function coverageEnabled(testInfo: TestInfo): boolean {
  // Playwright resolves non-built-in reporter names to their module path (.../monocart-reporter/...).
  return testInfo.config.reporter.some(([name]) => /(?:^|[\\/])monocart-reporter(?:[\\/]|$)/.test(name))
}

/**
 * Every spec runs under the shared guards from @wshno/playwright-config. cspGuard fails a spec on any
 * CSP violation, Report-Only included: in container mode the backend serves the production bundle with
 * the real policy (backend/src/Api/Security/SecurityHeaders.cs). The console and request guards start
 * in warn mode: React Native Web logs deprecation warnings, and the OpenStreetMap tiles depend on the
 * runner's internet access. They annotate the report until that is sorted out, then move to fail.
 *
 * `onboarded` (default true) marks first-run onboarding as done before the app loads, so a fresh
 * browser lands on the page under test instead of /onboarding. Onboarding's own spec turns it off.
 *
 * With coverage on, the test's own `page` records V8 JS coverage across navigations and hands it to
 * monocart-reporter at the end (see playwright.ci.config.ts). Extra pages (the OAuth popup) are not
 * recorded; a page the test already closed is skipped rather than failing the test.
 */
export const test = guardsTest.extend<{ onboarded: boolean }>({
  consoleGuard: { mode: 'warn' },
  requestGuard: { mode: 'warn' },
  onboarded: [true, { option: true }],
  page: async ({ page, onboarded }, use, testInfo) => {
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
    const collectCoverage = coverageEnabled(testInfo)
    if (collectCoverage) await page.coverage.startJSCoverage({ resetOnNavigation: false })
    await use(page)
    if (collectCoverage && !page.isClosed()) {
      const coverage = await page.coverage.stopJSCoverage()
      await addCoverageReport(coverage, testInfo)
    }
  },
})
