# CLAUDE.md

Guidance for working in this repo.

## What this is

`skylens` is an Android **AR plane-spotter**: an Expo/React Native app plus an ASP.NET Core 10
gateway. The app overlays aircraft labels on the camera preview using GPS + compass/gyro sensor
fusion (pinhole projection, no ARCore). The backend consumes a live ADS-B MQTT feed, keeps aircraft
state in memory, streams slim snapshots over a SignalR hub, and enriches on demand from OpenSky /
ADS-B Exchange / FlightAware AeroAPI behind caches and per-provider budgets. Auth is Authelia OIDC +
PKCE; the backend validates the JWT with audience `skylens-api`.

## Layout

- `app/` — Expo (React Native, TypeScript) app.
  - `app/app/` — expo-router screens (AR, map, settings, sign-in).
  - `app/src/ar/` — pure-TS geo + projection + orientation math (jest-testable on any OS).
  - `app/src/api|auth|state|mock|components/` — API/SignalR client, PKCE auth, zustand stores,
    demo-mode feed, UI components.
- `backend/` — ASP.NET Core 10 Minimal API + SignalR (`Skylens.slnx`, project `src/Api`, tests
  `tests/Api.Tests`). Ingest / State / Hubs / Broadcast / Enrichment / Endpoints.
- `Dockerfile` — backend image (publish + bake the pinned aircraft.csv.gz enrichment DB → aspnet runtime).

## Commands

```bash
# Backend — run from backend/ so the MTP test runner picks up global.json.
cd backend
dotnet build
dotnet test
dotnet run --project src/Api      # http://localhost:8080

# App
cd app
npm install
npm run typecheck                 # tsc --noEmit
npm run lint:ci                   # eslint --format json
npm test                          # jest
npx expo start
```

## Conventions & hard rules

- **The user commits and pushes.** Do not run `git add` / `git commit` / `git push` — leave the
  working tree staged for the user to review.
- **`dotnet test` must run from `backend/`** — `global.json` (which selects the SDK and the
  Microsoft.Testing.Platform runner) lives there. Running from the repo root will not find it.
- **Lockfiles are committed** — `backend/**/packages.lock.json` and `app/package-lock.json` are in
  git (locked-mode restore). Do not add them to `.gitignore`; when a NuGet bump lands, the
  `dependabot-update-dotnet-lockfiles` workflow regenerates them on the PR branch.
- **Never relay the raw ADS-B blob** to clients — the hub sends a slim per-aircraft DTO. Keep the
  filtering (radius, positioned-only) and the DTO shape as the bandwidth contract.
- **Enrichment spend is gated**: ADS-B Exchange / AeroAPI calls go through single-flight caching and
  per-provider budgets that fail closed. Route lookups are on-tap only. Do not add uncached fan-out
  to these providers.
- **No secrets or home coordinates in the repo.** MQTT credentials, provider API keys, and the
  home lat/lon live in the `skylens-secrets` Kubernetes Secret (created out-of-band), not in git.
- Reusable CI workflows are pinned to `hwinther/reusable-workflows` at a specific SHA (v2.0.0); keep
  every `uses:` pinned to a full commit SHA with the version in a trailing comment.

## Deployment

Kubernetes manifests live in the infra repo at `proxmox/clusters/production/apps/skylens-production/`
(plain namespace, Traefik ingress on `skylens.wsh.no`, JWT validated in-app — no forward-auth
middleware). The image `ghcr.io/hwinther/skylens/api` is built by the container workflow on tag and
deployed by Flux. Secrets are created out-of-band — see `skylens-secrets.md` there.
