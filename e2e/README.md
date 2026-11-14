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

## Against a deployed env (nightly preview)

`.github/workflows/nightly-preview.yml` deploys main to `skylens-nightly.preview.wsh.no` every night
and runs `playwright.ci.config.ts` against it with `BASE_URL` set. That host is behind Authelia and
the API runs real JwtBearer, so with `BASE_URL` the config:

- runs a `setup` project first (`tests/auth.setup.ts`): it signs the e2e user in through Authelia
  (password and TOTP from `E2E_USERNAME`, `E2E_PASSWORD`, `E2E_OTP_SECRET`), then through the app's
  sign-in popup (Authelia always asks for consent, since the client requests `offline_access`), and
  saves the storage state the `chromium` project starts from;
- skips specs tagged `@local-only` (`auth.spec.ts`, which stubs the IdP).

The preview replays the same fixtures from the same coarse feed origin, so the other specs assert the
same data as in the compose run.

## Coverage (container mode)

`playwright.ci.config.ts` adds `monocartReporter()` from `@wshno/playwright-config` after the shared
CI reporters, and `tests/fixtures.ts` merges in its `coverageTest`, which records V8 JS coverage of
each test's `page` (`resetOnNavigation: false`) whenever that reporter is configured, so plain
`npm test` (source mode) collects nothing. Extra pages such as
the OAuth popup are not recorded. The image's web export ships external source maps
(`expo export --source-maps`), which the reporter fetches from the app to map the bundle back to
`app/src/**` and `app/app/**`; node_modules (Leaflet, RN Web) and the Cesium runtime under `/cesium/`
are filtered out. Output: `monocart-coverage/` (`index.html` V8 report, `lcov.info`,
`cobertura-coverage.xml`), plus the monocart test report in `monocart-report/`. The compose
`playwright` service mounts `monocart-coverage/` back to the host.

In CI the reusable workflow uploads it as the `e2e-coverage` artifact (`coverage_paths_json`), and the
`coverage-summary` job in `pr-e2e.yml` (reusable-workflows' `e2e-coverage-summary.yml`) merges it
with jest's coverage. Locally, with the package's `wshno-coverage-summary`:

```bash
cd app && npm run coverage:ci && cd ../e2e
npm run coverage:summary          # Markdown: Unit (jest), E2E (Playwright), Combined + top e2e files
```

The merge is per file and line (covered if either side covers the line) and approximate: istanbul
counts statement lines, V8 counts every executable line through the source maps.

`e2e/` is its own npm package on `@wshno/playwright-config`, which pins Playwright and supplies the
shared defaults. Source mode still starts `expo start` in `../app`, so `npm install` there too.

Requirements: the .NET 10 SDK on `PATH` (the backend server is `dotnet run`) and the Chromium browser
(`npx playwright install chromium`, run once). No MQTT broker, OIDC provider, or device is needed.
`CI=1` makes the run non-reusing, retry-once, and `--forbid-only`.
