import { guardsTest } from '@wshno/playwright-config'

export { expect, type Page } from '@playwright/test'

/**
 * Every spec runs under the shared guards from @wshno/playwright-config. cspGuard fails a spec on any
 * CSP violation, Report-Only included: in container mode the backend serves the production bundle with
 * the real policy (backend/src/Api/Security/SecurityHeaders.cs). The console and request guards start
 * in warn mode: React Native Web logs deprecation warnings, and the OpenStreetMap tiles depend on the
 * runner's internet access. They annotate the report until that is sorted out, then move to fail.
 */
export const test = guardsTest.extend({
  consoleGuard: { mode: 'warn' },
  requestGuard: { mode: 'warn' },
})
