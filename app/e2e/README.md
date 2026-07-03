# Web ↔ backend E2E (Playwright)

`npm run e2e` builds the app for **web** (react-native-web) and drives it against a **real backend**,
proving the browser frontend renders aircraft that came from the backend API over SignalR.

## What it wires up

`playwright.config.ts` starts two managed servers and tears them down afterwards:

| Server | How it's made deterministic |
| --- | --- |
| **backend** (`../backend`, port 5099) | `ASPNETCORE_ENVIRONMENT=Development` + `Auth:Disabled=true` → the `DevAuth` handler stamps a fixed principal (no OIDC). `Mqtt:Replay=true` swaps the broker for `ReplayMqttTransport`, which re-publishes the committed `tests/Api.Tests/fixtures/aircraft.json` through the real ingest → state → SignalR pipeline at 1 Hz. `Cors:Origins` opens CORS to the web origin. |
| **web app** (`expo start --web`, port 8081) | `EXPO_PUBLIC_FORCE_LIVE=1` boots straight into live mode (not the demo replay); `EXPO_PUBLIC_API_BASE_URL` points at the backend; `EXPO_PUBLIC_HOME_LAT/LON` set the observer/subscription centre to the fixture centroid so the replayed planes fall inside the own-feed radius. |

The feed origin (`Feed:Lat/Lon`) and the app's home are the same point, so the backend serves an
own-feed (`src: "adsb"`) snapshot rather than falling back to away-mode/ADSBx.

## The tests (`live.spec.ts`)

1. **AR** — load `/`, assert the status strip's aircraft count rises above 0 (the SignalR snapshot
   reached the browser).
2. **Map** — load `/map`, assert the web list (`map.web.tsx`) renders ≥1 aircraft row.

Both rely on stable `testID`s (`status-aircraft-count`, `map-aircraft-count`, `map-ac-<hex>`) that
react-native-web exposes as `data-testid`.

## Running

```bash
cd app
npm run e2e            # starts both servers, runs Chromium, tears down
npm run e2e:report     # open the last HTML report
```

Requirements: the .NET 10 SDK on `PATH` (the backend server is `dotnet run`) and the Chromium browser
(`npx playwright install chromium`, run once). No MQTT broker, OIDC provider, or device is needed.
`CI=1` makes the run non-reusing, retry-once, and `--forbid-only`.
