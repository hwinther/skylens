/**
 * Container-mode Playwright config (CI: pr-e2e.yml -> reusable playwright-e2e.yml).
 *
 * Unlike playwright.config.ts (source mode, which starts dotnet + `expo start --web` itself via
 * webServer), this drives the ALREADY-RUNNING combined skylens image from docker-compose.e2e.yml:
 * the production Expo web bundle served same-origin with the API. So there is NO webServer here;
 * the compose stack is brought up by the reusable workflow before Playwright runs.
 *
 * Two container-mode specifics:
 *  - baseURL comes from the compose host port mapping (8081 -> container 8080), overridable via
 *    E2E_BASE_URL. The web bundle resolves the API base URL to window.location.origin, so browsing
 *    the container's own origin keeps the SPA and API same-origin.
 *  - The production bundle bakes NO EXPO_PUBLIC_HOME_LAT/LON, so on web the app reads
 *    navigator.geolocation. We grant the geolocation permission and pin coordinates to the compose
 *    FEED origin so the replayed aircraft fall inside the own-feed radius.
 *
 * The tests/ specs are shared with source mode: they assert on backend-driven data (aircraft counts,
 * map/list/detail) via stable testIDs and never touch sign-in, mock-auth texts, or baked env, so
 * they are mode-agnostic.
 *
 * Coverage: the image's web export ships external source maps (Dockerfile, `--source-maps`), so
 * monocartReporter() below maps each test's V8 JS coverage (coverageTest, via tests/fixtures.ts) back
 * to app/src and app/app and writes e2e/monocart-coverage/ (v8 html, cobertura, lcov). The shared CI
 * reporters stay first and unchanged: the reusable playwright-e2e.yml reads playwright-report/results.json.
 */
import { devices } from '@playwright/test'
import { ciReporters, definePlaywrightConfig, isCI, localReporters, monocartReporter } from '@wshno/playwright-config'
import { authFile } from './tests/auth-paths'

// BASE_URL = a deployed env (nightly-preview.yml, through reusable-workflows' playwright-e2e.yml): the
// preview host is behind Authelia and the API runs real JwtBearer, so a `setup` project signs the e2e
// user in first (tests/auth.setup.ts) and specs tagged @local-only (those that stub the IdP or need
// DevAuth) are skipped. The preview runs the same replay fixtures and coarse FEED origin as the compose
// stack, so the rest of the suite asserts the same data.
const DEPLOYED = process.env.BASE_URL
const BASE_URL = DEPLOYED ?? process.env.E2E_BASE_URL ?? 'http://localhost:8081'
const ORIGIN = new URL(BASE_URL).origin
const chromium = { ...devices['Desktop Chrome'] }

// Shared defaults (testDir ./tests, forbidOnly, the github/html/json CI reporters at the paths the
// reusable reads, trace, screenshot and video on failure) come from @wshno/playwright-config.
export default definePlaywrightConfig({
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ...(isCI ? ciReporters : localReporters),
    monocartReporter({
      name: 'skylens E2E',
      coverage: {
        // The app's own bundle chunks only: not the Cesium runtime under /cesium/, nor anything
        // cross-origin (OSM tiles, Esri, the stubbed IdP).
        entryFilter: (entry) => entry.url.startsWith(`${ORIGIN}/_expo/static/js/`),
        // Metro's project-root source paths (/src/..., /app/...) become app/src/... and app/app/...,
        // the same paths the unit report gets in the coverage summary; node_modules (Leaflet, RN Web)
        // drops out. The mocks don't count, as in the unit coverage (app/jest.config.js); the screens
        // (app/app, src/screens) do here, since they are this suite's to cover.
        layout: { root: 'app', sourceDirs: ['src', 'app'], exclude: /^app\/src\/mock\// },
      },
    }),
  ],
  use: {
    baseURL: BASE_URL,
    // Production web bundle has no baked home coords -> the app reads browser geolocation. Grant the
    // permission and pin to the compose FEED origin (coarse, 1-decimal) so aircraft are in range.
    permissions: ['geolocation'],
    geolocation: { latitude: 59.9, longitude: 11.1 },
  },
  grepInvert: DEPLOYED ? /@local-only/ : undefined,
  projects: DEPLOYED
    ? [
        { name: 'setup', testMatch: /auth\.setup\.ts/ },
        { name: 'chromium', use: { ...chromium, storageState: authFile }, dependencies: ['setup'] },
      ]
    : [{ name: 'chromium', use: chromium }],
})
