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
 * Coverage: the image's web export ships external source maps (Dockerfile, `--source-maps`), so the
 * monocart reporter below maps each test's V8 JS coverage (tests/fixtures.ts) back to app/src and
 * app/app and writes e2e/monocart-coverage/ (v8 html, cobertura, lcov). The shared CI reporters stay
 * first and unchanged: the reusable playwright-e2e.yml reads playwright-report/results.json.
 */
import { devices } from '@playwright/test'
import { ciReporters, definePlaywrightConfig, isCI, localReporters } from '@wshno/playwright-config'

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8081'
const ORIGIN = new URL(BASE_URL).origin

/**
 * Metro's source paths are project-root absolute ("/src/state/aircraftStore.ts", "/app/map.tsx",
 * "/node_modules/..."); monocart may prefix them with the host. Normalised to repo-relative app/...
 */
function toRepoPath(sourcePath: string): string {
  const path = sourcePath.replaceAll('\\', '/')
  if (path.includes('node_modules/') || /^app\/(?:src|app)\//.test(path)) return path
  const match = /(?:^|\/)((?:src|app)\/.+)$/.exec(path)
  return match ? `app/${match[1]}` : path
}

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
    [
      'monocart-reporter',
      {
        name: 'skylens E2E',
        outputFile: './monocart-report/index.html',
        coverage: {
          name: 'skylens E2E coverage',
          // The app's own bundle chunks only: not the Cesium runtime under /cesium/, nor anything
          // cross-origin (OSM tiles, Esri, the stubbed IdP).
          entryFilter: (entry: { url: string }) => entry.url.startsWith(`${ORIGIN}/_expo/static/js/`),
          // Keep the app's own source from the source maps; drop node_modules (Leaflet, RN Web, ...).
          sourceFilter: (sourcePath: string) => toRepoPath(sourcePath).startsWith('app/'),
          sourcePath: toRepoPath,
          outputDir: './monocart-coverage',
          reports: ['v8', 'cobertura', 'lcov'],
          // One self-contained index.html, so the downloaded artifact opens from file://.
          inline: true,
        },
      },
    ],
  ],
  use: {
    baseURL: BASE_URL,
    // Production web bundle has no baked home coords -> the app reads browser geolocation. Grant the
    // permission and pin to the compose FEED origin (coarse, 1-decimal) so aircraft are in range.
    permissions: ['geolocation'],
    geolocation: { latitude: 59.9, longitude: 11.1 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
