/**
 * Playwright E2E: drives the react-native-web build against a real backend, proving the web
 * frontend renders aircraft that came from the backend API.
 *
 * Two managed servers:
 *  - backend (../backend): started in Development with the DevAuth handler (Auth:Disabled) and a
 *    file-replay MQTT transport (Mqtt:Replay) that re-publishes the captured aircraft.json through
 *    the real ingest → state → SignalR pipeline. CORS is opened to the web origin.
 *  - web app (expo start --web): built in live mode (EXPO_PUBLIC_FORCE_LIVE) pointed at the backend,
 *    with a fixed home location so the hub subscription is centred on the replayed aircraft.
 *
 * The feed origin and the app's home are the same point, so the replayed planes fall inside the
 * own-feed radius and the browser receives an "adsb" snapshot over SignalR.
 */

import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const BACKEND_PORT = 5099;
const WEB_PORT = 8081;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

// Fixture centre (Oslo TMA) — shared by the app's live observer and the backend feed origin.
const HOME_LAT = "59.914";
const HOME_LON = "11.063";
const REPLAY_FILE = path.resolve(__dirname, "../backend/tests/Api.Tests/fixtures/aircraft.json");

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: WEB_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // --no-launch-profile: ignore Properties/launchSettings.json so the E2E is driven purely by
      // the env below (Development + port 5099), independent of the local-dev http profile.
      command: "dotnet run --project src/Api --no-launch-profile",
      cwd: path.resolve(__dirname, "../backend"),
      url: `${BACKEND_URL}/healthz`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ASPNETCORE_ENVIRONMENT: "Development",
        ASPNETCORE_URLS: BACKEND_URL,
        Auth__Disabled: "true",
        Mqtt__Replay: "true",
        Mqtt__Host: "replay",
        Mqtt__ReplayFile: REPLAY_FILE,
        Feed__Lat: HOME_LAT,
        Feed__Lon: HOME_LON,
        Feed__RadiusKm: "500",
        Cors__Origins: WEB_URL,
      },
    },
    {
      command: `npx expo start --web --port ${WEB_PORT}`,
      cwd: __dirname,
      url: WEB_URL,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        BROWSER: "none",
        EXPO_NO_TELEMETRY: "1",
        EXPO_PUBLIC_API_BASE_URL: BACKEND_URL,
        EXPO_PUBLIC_FORCE_LIVE: "1",
        EXPO_PUBLIC_HOME_LAT: HOME_LAT,
        EXPO_PUBLIC_HOME_LON: HOME_LON,
      },
    },
  ],
});
