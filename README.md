# skylens

An Android **AR plane-spotter**: point your phone at the sky and see labels identifying the aircraft
overhead, driven by GPS + compass/gyro. An Expo/React Native app talks to an ASP.NET Core gateway that
streams a live ADS-B feed and enriches it on demand.

## What it is

- **`app/`** — Expo (React Native, TypeScript) app. AR mode overlays aircraft labels on the camera
  preview using a sensor-fusion pipeline (GPS + rotation vector projected through a pinhole model —
  no ARCore/SLAM; the planes are effectively at infinity). Also has a map/list fallback and a
  **demo mode** that replays recorded traffic for development on an emulator or desktop.
- **`backend/`** — ASP.NET Core 10 Minimal API + SignalR gateway. Consumes an ADS-B MQTT feed,
  keeps an in-memory aircraft state store, and pushes a slim per-subscriber snapshot over a SignalR
  hub (~1 Hz). Enriches aircraft with registration/type (bundled offline DB, OpenSky fallback),
  away-area coverage (ADS-B Exchange), and on-tap route lookups (FlightAware AeroAPI), all behind
  single-flight caching and per-provider budgets to protect API quotas.

Access requires sign-in: **Authelia OIDC + PKCE**, and the backend validates the RFC 9068 JWT with
audience `skylens-api`. This keeps the enrichment API quotas away from bots and scrapers.

The container image is `ghcr.io/hwinther/skylens/api`, deployed to `skylens.wsh.no`.

## Repo layout

```
skylens/
├── app/          # Expo / React Native app (AR overlay, map, auth, demo mode)
│   └── src/ar/   # pure-TS geo + projection math (unit-tested, runs on any OS)
├── backend/      # ASP.NET Core 10 gateway (Skylens.slnx, project src/Api, tests tests/Api.Tests)
├── Dockerfile    # backend image build (publish + baked aircraft DB → aspnet runtime)
├── GitVersion.yml
└── .github/      # CI, dependabot, labeler, security scans
```

## Develop

### Backend

```bash
cd backend
dotnet test                       # MTP test runner — must run from backend/ (global.json lives here)
dotnet run --project src/Api      # http://localhost:8080
```

The MQTT ingest connects to the ADS-B feed on startup; `/healthz` degrades if no message arrives for
30 s. A dev-only `Auth__Disabled` escape hatch skips JWT validation for local API iteration.

### App

```bash
cd app
npm install
npx expo start                    # Expo Go for camera/GPS/sensors; a dev build is needed for OAuth
npm run typecheck                 # tsc --noEmit
npm test                          # jest (pure AR math + component tests)
```

**Demo mode** replays a recorded aircraft snapshot series with a drag-to-look pose, so the AR overlay
can be exercised on an emulator or a desktop with no live feed and no SDR hardware.

## Build & release

CI runs on every PR (`.github/workflows/ci.yml` → reusable `pr-build`): dotnet build/test for
`backend/` and node typecheck/lint/build/test for `app/`.

Releases are tag-driven: run the **Create tag and release** workflow (or push a `vX.Y.Z` tag) and the
**Publish container to GHCR** workflow builds and pushes `ghcr.io/hwinther/skylens/api`, from which
Flux deploys the running gateway. There is no APK signing in CI — the Android app is sideloaded first,
with Google Play internal testing later.

## Attribution

Orbital data courtesy of [CelesTrak](https://celestrak.org/). Satellite transmitter data from the
[SatNOGS DB](https://db.satnogs.org/) (CC BY-SA). AIS/ADS-B from local receivers.
