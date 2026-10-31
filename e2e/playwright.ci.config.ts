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
 */
import { devices } from "@playwright/test";
import { definePlaywrightConfig } from "@wshno/playwright-config";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8081";

// Shared defaults (testDir ./tests, forbidOnly, the github/html/json CI reporters at the paths the
// reusable reads, trace, screenshot and video on failure) come from @wshno/playwright-config.
export default definePlaywrightConfig({
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    baseURL: BASE_URL,
    // Production web bundle has no baked home coords -> the app reads browser geolocation. Grant the
    // permission and pin to the compose FEED origin (coarse, 1-decimal) so aircraft are in range.
    permissions: ["geolocation"],
    geolocation: { latitude: 59.9, longitude: 11.1 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
