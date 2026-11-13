# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`skylens` is an Android **AR sky-spotter**: an Expo/React Native app plus an ASP.NET Core 10
gateway. The app overlays labels on the camera preview using GPS + compass/gyro sensor fusion
(pinhole projection, no ARCore — targets are effectively at infinity). Aircraft are the core layer;
it also shows AIS vessels, satellites (CelesTrak TLEs, SatNOGS transmitters), planets/moon/sky
events, airports, and fishing layers.

The backend consumes live ADS-B and AIS MQTT feeds, keeps state in memory, streams slim snapshots
over a SignalR hub (~1 Hz), and enriches on demand from OpenSky / FlightAware AeroAPI behind caches
and per-provider budgets. Viewers outside the home feed's range get away-mode traffic from adsb.lol
(free), then adsb.fi (free; airplanes.live is wired but off until they grant access), with ADS-B
Exchange as an optional paid last resort (vessels: BarentsWatch for Norway, then the aisstream.io
WebSocket stream elsewhere when `AisStream:ApiKey` is set). Auth is Authelia
OIDC + PKCE; the backend validates the RFC 9068 JWT with audience `skylens-api`.

## Layout

- `app/` — Expo (React Native, TypeScript) app.
  - `app/app/` — expo-router screens (AR `index`, map, list, settings, sign-in, onboarding, oauth).
  - `app/src/ar/` — pure-TS geo, projection, orientation, and astronomy math (jest-testable on any OS).
  - `app/src/api|auth|state|mock|components|screens/` — API/SignalR client, PKCE auth, zustand
    stores, demo-mode feed, UI components and hooks.
  - `*.web.tsx` / `*.web.ts` siblings are the react-native-web variants (e.g. the map screen
    becomes a Leaflet/list view, web camera + DeviceOrientation sensors).
- `backend/` — ASP.NET Core 10 Minimal API + SignalR (`Skylens.slnx`, project `src/Api`, tests
  `tests/Api.Tests`, xunit v3 on Microsoft.Testing.Platform).
- `e2e/` — Playwright web ↔ backend suite, its own npm package (see `e2e/README.md`).
- `deploy/` — kustomize workload manifests, rendered and pushed as a signed OCI artifact on release
  (see `deploy/README.md` for the variable contract). Don't commit rendered output.
- `firmware/rotator-esp32/` — ESP32 antenna-rotator sketch (`docs/rotator-concept.md`).
- `Dockerfile` — single image: exports the web app into `wwwroot`, publishes the API, bakes the
  pinned aircraft/airport CSV DBs and replay fixtures → chiseled aspnet runtime.

## Commands

```bash
# Backend — run from backend/ so the MTP test runner picks up global.json.
cd backend
dotnet build                      # Debug build also regenerates src/Api/openapi.json
dotnet test
dotnet test --project tests/Api.Tests --filter-class "*AircraftStateStoreTests"   # one class
dotnet test --project tests/Api.Tests --filter-method "*SomeTestName"              # one test
dotnet run --project src/Api      # http://localhost:8080

# App
cd app
npm install
npm run typecheck                 # tsc --noEmit
npm run lint                      # eslint, --max-warnings 0 (lint:ci = JSON output)
npm test                          # jest: both projects (logic + native)
npx jest src/ar/projection        # one file;  add -t "name" for one test
npx jest --selectProjects native  # only the component tests (also: npx jest __tests__/native/Sheet)
npm run openapi:generate          # regenerate src/api/generated/schema.ts from backend openapi.json
npx expo start                    # dev build needed for OAuth; Expo Go is fine for sensors/demo
npx expo start --web              # react-native-web build

# E2E (own package on @wshno/playwright-config; needs app/ installed too, plus
# `npx playwright install chromium` once)
cd e2e
npm install
npm test                          # source mode: starts backend (5099) + expo web (8081)
npm run test:ci                   # container mode against docker-compose.e2e.yml (+ JS coverage)
npm run coverage:summary          # unit (../app/coverage) + e2e (monocart-coverage) lcov -> Markdown
```

## Architecture notes

- **Backend pipeline** (wired in `Program.cs`): `Ingest/MqttIngestService` reads an `IMqttTransport`
  (`MqttNetTransport`, or `ReplayMqttTransport` when `Mqtt:Replay=true`, which replays committed
  fixtures through the real pipeline) → `Dump1090Parser` / `AisCatcherParser` → `State/*StateStore`
  (hosted services; also prune stale entries) → `Broadcast/SnapshotBroadcaster` / `VesselBroadcaster`
  push per-viewer filtered DTOs to `Hubs/AircraftHub` (`/hubs/aircraft`). `ViewerRegistry` tracks
  each subscriber's centre/radius; viewers outside the own-feed range are served from
  `AwayModeChain` (adsb.lol → airplanes.live → adsb.fi → ADSBx; all `ReadsbPointSource`s sharing the
  0.5° cell cache). New providers must also be disabled in `docker-compose.e2e.yml`,
  `e2e/playwright.config.ts` and `deploy/components/preview` so replays never mix in live traffic. Vessels go
  through `VesselAwayChain` (BarentsWatch → `AisStreamClient`); unlike the aircraft chain an empty answer
  also falls through, since BarentsWatch answers empty outside Norway. `AisStreamClient` is a hosted
  service holding one socket, subscribed only to the 1° cells viewers asked about recently. `/healthz` degrades if no MQTT message arrives for 30 s.
- **Enrichment** (`Enrichment/`): offline `AircraftDbService` / `AirportDbService` (CSV.gz baked into
  the image), with `MetadataService` falling back to OpenSky; every remote client goes through
  `EnrichmentCache` (single-flight) and `UpstreamBudget`.
- **OpenAPI contract**: Debug builds run `dotnet swagger tofile` to write `src/Api/openapi.json`
  (kept byte-stable; CI fails on changes after build). After changing endpoints, build, commit the
  updated `openapi.json`, and run `npm run openapi:generate` in `app/`.
- The same API process serves the exported web app from `wwwroot` (SPA fallback to `index.html`)
  with security headers + CSP (`Security/`); CSP reports post back to the API.
- **Sign-in gating (app)**: the root layout probes an anonymous `GET /api/me` at startup
  (`src/auth/access.ts`; 200 under DevAuth → `authRequired=false`, 401 → `true`, retried every 5 s
  while unknown). `useApiAllowed()` / `isApiAllowed()` (`state/authStore`) is the gate every API caller
  checks: no hub connection and no REST calls while sign-in is required and there is no session (demo
  still works on-device). Live mode then shows `SignInPrompt` instead. The web session persists in
  localStorage (`state/persistStorage`, key `skylens.tokens.v1`; SecureStore on native), shared across
  tabs: `refresh.ts` re-reads storage before refreshing and before giving up, and the root layout
  follows the `storage` event. `ApiClient` refreshes once and retries on a 401 with a real session.
- **Local/dev escape hatches**: `Auth:Disabled=true` (Development only) swaps in `DevAuthHandler`
  with a fixed principal. App env: `EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_FORCE_LIVE=1` (skip demo
  mode), `EXPO_PUBLIC_HOME_LAT/LON`. `npm run reverse:android` maps the device's port 5000 to the host.
- **Jest projects** (`app/jest.config.js`): `logic` runs `__tests__/*.test.ts` on `jest-expo/node`
  (pure TS, no RN runtime); `native` runs `__tests__/native/**/*.test.tsx` on `jest-expo/android` with
  `@testing-library/react-native` (v14: `render`/`fireEvent`/`act` are async, so `await` them). Shared
  native mocks (react-native-maps as plain Views, camera, sensors, location, fonts, router) live in
  `__tests__/native/setup.ts`; seed data through the real zustand stores (`__tests__/native/fixtures.ts`).
  API callers stay gated (signed out behind auth) and `fetch` rejects, so no test touches the network.
  Reporters and coverage are top-level, so `coverage/junit-report.xml` + `cobertura-coverage.xml` cover both.
- **Route error boundaries**: every route file in `app/app/` ends with
  `export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteErrorBoundary";`, so a crash
  in one screen shows a retry fallback there (tab bar intact) and is reported once via `clientLog`
  (`POST /api/client-log`, scrubbed message + path only). Add it to any new route.
- **Map tab** opens on the geographic map; Radar is the second toggle (`useMapViewMode` in
  `src/components/webmap/`, shared by both Map screens). On Android the map needs a Google Maps key:
  `app.config.js` sets `extra.hasMapsKey` (boolean only), and without it the tab opens on Radar
  (`isMapAvailable`). E2E that wants blips must click `map-view-radar` first. The geographic map's
  satellites layer (`showMapSatellites`, Settings `settings-show-map-satellites`, needs `showSatellites`)
  draws exactly the List's Overhead set (shared `useOverheadSatellites`) at sub-satellite points
  (`map-sat-<norad>`), re-placed at the 1 Hz satellite tick; a tap opens the satellite card. One
  coverage footprint (pure `src/ar/footprint.ts`) for the open card's satellite, else the tracked one;
  policy in `webmap/satelliteLayer.ts`. The Radar plots no satellites.
- **Demo mode** (`src/mock/`) replays `recorded-aircraft.json` with a drag-to-look pose, so the AR
  overlay works on an emulator or desktop with no feed.
- **Signal lost** (`src/ar/signalLost.ts`): the one definition of a stale target, from the per-kind
  `trackLimits` in `src/ar/positionTracker.ts`, measured on the tracker's sample (the own feed re-sends a
  quiet aircraft's last position with its old `seenPos`, so the DTO alone never looks stale). The sim HUD
  and the AR overlay both use it; AR dims lost aircraft/ships (dashed chip, hollow anchor
  `ar-ac-lost-<hex>` / `ar-ves-lost-<mmsi>`, "lost · 45 s", hollow edge arrow) and reports them to the
  AR screen's detail card. Satellites are propagated from TLEs and are never "lost".
- **Simulator / cockpit view** (`/sim`, web + Android): a Cesium globe (Esri World Imagery + terrain)
  with the camera on the followed aircraft/vessel/satellite. The scene (camera, forward marker, label
  layers, drag-to-look) is imperative, shared code in `src/sim/simGlobe.ts`; the HUD is
  `src/components/SimHud.tsx`. Web: `src/screens/SimScreen.web.tsx`. Android: `src/screens/SimScreen.tsx`
  (native HUD/buttons/loading + failure states/back button) around `src/components/SimGlobeView.tsx`, an
  Expo DOM component (`"use dom"`, @expo/dom-webview, separate JS context): it gets the latest sample /
  satellite OMM as JSON props, fetches labels through the `loadOverlay` native action (API + auth stay
  native, no token in the webview) and reports back via `onReady`/`onFailed`/`onImagery`/`onLook`/
  `onDiagnostic` (native testIDs `sim-globe-loading|ready|failed`). Globe health (tile counts, WebGL
  renderer, worker + pixel probes, page errors) is counted in pure-TS `src/sim/globeDiag.ts`, logged with
  the prefix `SkylensSim` (logcat) and, in builds with `EXPO_PUBLIC_SIM_DIAG=1` (the Maestro CI APK),
  put on a hidden `sim-globe-diag` node; its `imageryVerdict` drives the "Map imagery unavailable
  (reason)" note. Cesium is NOT bundled by Metro:
  `scripts/copy-cesium.mjs` (postinstall) copies its prebuilt runtime to `public/cesium/` (gitignored),
  and `src/sim/loadCesium.ts` loads it with a `<script>` tag from `cesiumBaseUrl(EXPO_BASE_URL)`: `/cesium/`
  on the web, and in a release APK `www.bundle/cesium/` next to the DOM page, because Expo's embed export
  copies all of `public/` into the APK's assets once the app has a DOM component (~13 MB raw, ~6 MB
  compressed; keep other big files out of `public/`). Pose math lives in pure-TS `src/sim/` (jest-tested).
  Following works by re-centring the hub subscription on the target (`simStore` → `_layout.tsx`), not by
  any new backend call. Esri hosts are allowed in the CSP. Map aids: `src/components/SimMinimap.tsx`
  (Leaflet inset, web only; Android has a "Map" button) and airport + port labels drawn as Cesium
  `LabelCollection`/`PointPrimitiveCollection` from `/api/airports` and `/api/ports`; the policy (zoom,
  ranges, refetch, label items) is pure TS in `src/sim/overlay.ts`. Looking around (drag, or on the web
  "Pan/tilt" with the phone's DeviceOrientation via `useWebArSensors`) is an offset from the direction of
  travel; a "straight ahead" marker and Recenter keep it findable (`src/sim/look.ts`). Maestro covers the
  Android screen in `app/.maestro/cockpit.yaml` (globe state screenshot-only, see its README).
- **Ports layer** (`GET /api/ports`, `PortDbService`): an offline file committed at
  `data/ports/ports.csv.gz`, built by `node data/ports/extract-osm-ports.mjs [--wpi UpdatedPub150.csv]`:
  OpenStreetMap (Overpass) for Norway + the NGA World Port Index elsewhere. Refresh by re-running the
  script and committing the output; the image bakes it and sets `Ports__PortsPath`. Show the
  attribution (ODbL) wherever ports appear.
- **Hidden routes**: in expo-router 58, `href: null` on a `Tabs.Screen` makes it `hidden`, and hidden
  routes redirect to `/`. To keep a route navigable without a tab button, use `HIDDEN_ROUTE`
  (`tabBarItemStyle: { display: "none" }`) in `app/_layout.tsx` instead. That only hides the button;
  `FULL_SCREEN_ROUTE` also hides the bar (`sim`, `onboarding`, `oauth`). `sign-in` keeps the bar on
  purpose: its own exits are only "sign in" or "switch to demo".
- **E2E onboarding**: a fresh browser is routed to `/onboarding`. The shared fixture
  (`e2e/tests/fixtures.ts`) marks onboarding done by default; opt out with `test.use({ onboarded: false })`.
- **E2E coverage**: the image's web export ships external source maps (`expo export --source-maps`,
  served from wwwroot like the chunks). In container mode (`playwright.ci.config.ts`) the fixture
  (`e2e/tests/fixtures.ts`, `coverageTest` from `@wshno/playwright-config`) records each test page's
  V8 JS coverage and `monocartReporter()` maps it back to `app/src` / `app/app` (filters drop
  node_modules and `/cesium/`) into `e2e/monocart-coverage/` (v8 html, cobertura, lcov). `pr-e2e.yml`
  uploads it as the `e2e-coverage` artifact, and its `coverage-summary` job (reusable-workflows'
  `e2e-coverage-summary.yml`; unit side from the `unit` job on main, a jest re-run on PRs) posts
  Unit / E2E / Combined line coverage (approximate: istanbul vs V8 lines) as a job summary and its own
  sticky PR comment, separate from ci.yml's unit-test comment. Plain `npm test` collects nothing.
- E2E relies on stable `testID`s (`status-aircraft-count`, `map-aircraft-count`, `map-ac-<hex>`,
  `sim-*`); keep them when touching those components.
- **Maestro smoke (Android)**: `app/.maestro/smoke.yaml` drives the release APK in demo mode on an
  emulator (onboarding Skip → AR → List + detail card → Map or Radar → Settings; how to run it locally
  in `app/.maestro/README.md`). `.github/workflows/android-e2e.yml` builds an x86_64 `assembleRelease`
  (template debug signing, JS embedded) and runs it on an API 34 `google_apis` emulator nightly, on
  dispatch, and on PRs labelled `mobile-e2e`; it caches Gradle (setup-gradle) and the NDK C++ compile
  (ccache), written from main only. It selects by testID (Android resource-id), incl. the tab
  buttons `tab-ar|map|list|settings` (`tabBarButtonTestID`), `onboarding-skip`, `status-source`
  (DEMO/LIVE badge), `list-ac-<hex>`, `detail-card*`, `map-view-*`, `radar`, `settings-demo-mode`.

## Conventions & hard rules

- **The user commits and pushes.** Do not run `git add` / `git commit` / `git push` — leave the
  working tree for the user to review.
- **`dotnet test` must run from `backend/`** — `global.json` (which selects the SDK and the
  Microsoft.Testing.Platform runner) lives there. Running from the repo root will not find it.
- **Lockfiles are committed** — `backend/**/packages.lock.json`, `app/package-lock.json` and
  `e2e/package-lock.json` are in git (locked-mode restore). Do not add them to `.gitignore`; when a
  NuGet bump lands, the `dependabot-update-dotnet-lockfiles` workflow regenerates them on the PR branch.
- **Never relay the raw ADS-B/AIS blob** to clients — the hub sends a slim per-object DTO
  (`AircraftDto`, `VesselDto`). Keep the filtering (radius, positioned-only) and the DTO shape as
  the bandwidth contract.
- **Enrichment spend is gated**: adsb.lol / ADS-B Exchange / AeroAPI (and other upstream) calls go
  through single-flight caching and per-provider budgets that fail closed. Route lookups are on-tap
  only. Do not add uncached fan-out to these providers.
- **No secrets or home coordinates in the repo.** MQTT credentials, provider API keys, and the home
  lat/lon live in the `skylens-secrets` Kubernetes Secret (created out-of-band), not in git.
- Reusable CI workflows come from `hwinther/reusable-workflows`; keep every `uses:` pinned to a
  full commit SHA with the version in a trailing comment.

## Deployment

Releases are tag-driven (`tag-and-release.yml`, or push `vX.Y.Z`). `container.yml` builds
`ghcr.io/hwinther/skylens/api` and renders `deploy/` into the signed OCI artifact
`ghcr.io/hwinther/skylens/manifests:<version>`, which the cluster repo (hwinther/proxmox) consumes
via Flux and supplies the namespace, network policies, Secret, and substitution variables. Ingress is
Traefik on `skylens.wsh.no`; the JWT is validated in-app (no forward-auth). PRs labelled
`deploy-feature` get a preview deployment (Development mode, replayed fixtures). The Android app is
sideloaded (`android-build.yml`, an uncached signed AAB with arm64-v8a + armeabi-v7a only); Play
setup is in `docs/google-play-setup.md`.
