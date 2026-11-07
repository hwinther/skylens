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
npm test                          # jest (preset jest-expo/node)
npx jest src/ar/projection        # one file;  add -t "name" for one test
npm run openapi:generate          # regenerate src/api/generated/schema.ts from backend openapi.json
npx expo start                    # dev build needed for OAuth; Expo Go is fine for sensors/demo
npx expo start --web              # react-native-web build

# E2E (own package on @wshno/playwright-config; needs app/ installed too, plus
# `npx playwright install chromium` once)
cd e2e
npm install
npm test                          # source mode: starts backend (5099) + expo web (8081)
npm run test:ci                   # container mode against docker-compose.e2e.yml
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
- **Local/dev escape hatches**: `Auth:Disabled=true` (Development only) swaps in `DevAuthHandler`
  with a fixed principal. App env: `EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_FORCE_LIVE=1` (skip demo
  mode), `EXPO_PUBLIC_HOME_LAT/LON`. `npm run reverse:android` maps the device's port 5000 to the host.
- **Demo mode** (`src/mock/`) replays `recorded-aircraft.json` with a drag-to-look pose, so the AR
  overlay works on an emulator or desktop with no feed.
- **Simulator / cockpit view** (`/sim`, web only for now): `src/screens/SimScreen.web.tsx` renders a
  Cesium globe (Esri World Imagery + terrain) with the camera on the followed aircraft/vessel/satellite.
  Cesium is NOT bundled by Metro: `scripts/copy-cesium.mjs` (postinstall) copies its prebuilt runtime
  to `public/cesium/` (gitignored), and `src/sim/loadCesium.ts` loads it with a `<script>` tag. Pose math
  lives in pure-TS `src/sim/` (jest-tested). Following works by re-centring the hub subscription on the
  target (`simStore` → `_layout.tsx`), not by any new backend call. Esri hosts are allowed in the CSP.
  Map aids: `src/components/SimMinimap.tsx` (Leaflet inset, web only) and airport + port labels drawn as
  Cesium `LabelCollection`/`PointPrimitiveCollection` from `/api/airports` and `/api/ports`; the policy
  (zoom, ranges, refetch) is pure TS in `src/sim/overlay.ts`. Looking around (drag, or "Pan/tilt" with
  the phone's DeviceOrientation via `useWebArSensors`) is an offset from the direction of travel; a
  "straight ahead" marker and Recenter keep it findable (`src/sim/look.ts`).
- **Ports layer** (`GET /api/ports`, `PortDbService`): an offline file committed at
  `data/ports/ports.csv.gz`, built by `node data/ports/extract-osm-ports.mjs [--wpi UpdatedPub150.csv]`:
  OpenStreetMap (Overpass) for Norway + the NGA World Port Index elsewhere. Refresh by re-running the
  script and committing the output; the image bakes it and sets `Ports__PortsPath`. Show the
  attribution (ODbL) wherever ports appear.
- **Hidden routes**: in expo-router 58, `href: null` on a `Tabs.Screen` makes it `hidden`, and hidden
  routes redirect to `/`. To keep a route navigable without a tab button, use `HIDDEN_ROUTE`
  (`tabBarItemStyle: { display: "none" }`) in `app/_layout.tsx` instead.
- **E2E onboarding**: a fresh browser is routed to `/onboarding`. The shared fixture
  (`e2e/tests/fixtures.ts`) marks onboarding done by default; opt out with `test.use({ onboarded: false })`.
- E2E relies on stable `testID`s (`status-aircraft-count`, `map-aircraft-count`, `map-ac-<hex>`,
  `sim-*`); keep them when touching those components.

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
sideloaded (`android-build.yml`); Play setup is in `docs/google-play-setup.md`.
