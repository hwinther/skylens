# Web ↔ backend E2E (Playwright)

`npm test` (in `e2e/`) builds the app for **web** (react-native-web) and drives it against a **real backend**,
proving the browser frontend renders aircraft that came from the backend API over SignalR.

## What it wires up

`playwright.config.ts` starts two managed servers and tears them down afterwards:

| Server | How it's made deterministic |
| --- | --- |
| **backend** (`../backend`, port 5099) | `ASPNETCORE_ENVIRONMENT=Development` + `Auth:Disabled=true` → the `DevAuth` handler stamps a fixed principal (no OIDC). `Mqtt:Replay=true` swaps the broker for `ReplayMqttTransport`, which re-publishes the committed `tests/Api.Tests/fixtures/aircraft.json` through the real ingest → state → SignalR pipeline at 1 Hz. `Cors:Origins` opens CORS to the web origin. |
| **web app** (`expo start --web`, port 8081) | `EXPO_PUBLIC_FORCE_LIVE=1` boots straight into live mode (not the demo replay); `EXPO_PUBLIC_API_BASE_URL` points at the backend; `EXPO_PUBLIC_HOME_LAT/LON` set the observer/subscription centre to the fixture centroid so the replayed planes fall inside the own-feed radius. |

The feed origin (`Feed:Lat/Lon`) and the app's home are the same point, so the backend serves an
own-feed (`src: "adsb"`) snapshot rather than falling back to away-mode/ADSBx.

## The tests (`tests/live.spec.ts`)

1. **AR** — load `/`, assert the status strip's aircraft count rises above 0 (the SignalR snapshot
   reached the browser).
2. **Map** — load `/map`, assert the web list (`map.web.tsx`) renders ≥1 aircraft row.

Both rely on stable `testID`s (`status-aircraft-count`, `map-aircraft-count`, `map-ac-<hex>`) that
react-native-web exposes as `data-testid`.

## Running

```bash
cd e2e
npm install
npm test               # starts both servers, runs Chromium, tears down
npm run report         # open the last HTML report
npm run test:ci        # container mode against docker-compose.e2e.yml
```

CI runs container mode from its own image: `e2e/Dockerfile` bakes the suite into an image on
`ghcr.io/wshno/playwright-config` (same version as the lock file), run as the `playwright` service of
`docker-compose.e2e.yml`. The API traces to the stack's OTel collector (`e2e/otel-out/traces.jsonl`)
and the PR comment lists API requests over 2 s. The same locally:

```bash
docker build -t skylens-e2e:local e2e
API_IMAGE=... docker compose -f docker-compose.e2e.yml up -d --wait
API_IMAGE=... docker compose -f docker-compose.e2e.yml --profile e2e run --rm playwright
```

`e2e/` is its own npm package on `@wshno/playwright-config`, which pins Playwright and supplies the
shared defaults. Source mode still starts `expo start` in `../app`, so `npm install` there too.

Requirements: the .NET 10 SDK on `PATH` (the backend server is `dotnet run`) and the Chromium browser
(`npx playwright install chromium`, run once). No MQTT broker, OIDC provider, or device is needed.
`CI=1` makes the run non-reusing, retry-once, and `--forbid-only`.
