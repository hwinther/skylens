# syntax=docker/dockerfile:1
#
# Single image for the skylens gateway: ASP.NET Core 10 Minimal API + SignalR, serving the Expo web
# app (SPA) from wwwroot same-origin, with the pinned wiedehopf/tar1090-db aircraft.csv.gz baked in
# for offline registration/type enrichment. Pure .NET runtime — multi-arch OK (no native binaries).

# 1) Build the Expo web SPA -> /src/app/dist
FROM node:26-bookworm-slim AS web
WORKDIR /src/app
# Restore first for layer caching. .npmrc carries legacy-peer-deps=true and is load-bearing for `npm ci`.
# --omit=dev: `expo export` only needs the prod tree (babel-preset-expo rides in via expo) — skipping
# jest/eslint/playwright halves the install and drops their deprecated transitive chains (inflight,
# glob@7/@10, jsdom's abab/domexception) from the build log. The one remaining deprecation warning
# (uuid@7 via expo -> @expo/config-plugins -> xcode) is upstream Expo's and harmless: that chain is
# iOS-prebuild tooling, never executed here and never part of the exported bundle.
COPY app/package.json app/package-lock.json app/.npmrc ./
# postinstall (scripts/copy-cesium.mjs) copies Cesium's runtime into public/cesium, which
# `expo export` ships into dist → wwwroot for the simulator.
COPY app/scripts/ ./scripts/
RUN npm ci --omit=dev --no-audit --no-fund
COPY app/ ./
# Version metadata + force-live are compiled into the public JS bundle. NEVER add EXPO_PUBLIC_HOME_LAT/LON/ALT
# (secret home coordinates) and NO EXPO_PUBLIC_API_BASE_URL (the app resolves the gateway same-origin).
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ENV EXPO_PUBLIC_FORCE_LIVE=1 \
    EXPO_PUBLIC_APP_VERSION=$APP_VERSION \
    EXPO_PUBLIC_GIT_SHA=$GIT_SHA
# --source-maps: external .js.map files next to each hashed chunk, linked by a `sourceMappingURL`
# comment (Metro's sectioned maps, sources as "/src/..." / "/app/..." with sourcesContent). The e2e
# coverage (e2e/playwright.ci.config.ts) maps the browser's V8 coverage back to app/ source through
# them; they also make production stack traces readable. Served by UseStaticFiles like the chunks
# (~12 MB uncompressed, fetched only by devtools / the coverage reporter).
RUN npx expo export --platform web --source-maps

# 2) Publish the API -> /app/publish. The SPA is copied into wwwroot BEFORE publish so it's embedded.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS backend
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
WORKDIR /src
COPY backend/ ./backend/
COPY --from=web /src/app/dist/ ./backend/src/Api/wwwroot/
# The SDK appends "+$(SourceRevisionId)" to InformationalVersion → parsed back apart by ApiBuildMetadata.
RUN dotnet publish backend/src/Api/Api.csproj -c Release -o /app/publish /p:UseAppHost=false \
    -p:InformationalVersion="$APP_VERSION" -p:SourceRevisionId="$GIT_SHA"

# 3) Fetch the PINNED offline aircraft DB and verify its checksum. Pinning the git commit + sha256
#    keeps the baked DB reproducible; a mismatch fails the build rather than shipping a swapped file.
FROM debian:trixie-slim AS aircraftdb
ENV DEBIAN_FRONTEND=noninteractive
ENV AIRCRAFT_DB_URL=https://raw.githubusercontent.com/wiedehopf/tar1090-db/8661aac00ad9caf09aac9f8ebe614ad1c35632bc/aircraft.csv.gz
ENV AIRCRAFT_DB_SHA256=f35926918a40d9acdae6e5970f748d5f5948cb0289fb013bf3bbe5c7dbeb3221
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    mkdir -p /out; \
    curl -fsSL "$AIRCRAFT_DB_URL" -o /out/aircraft.csv.gz; \
    echo "${AIRCRAFT_DB_SHA256}  /out/aircraft.csv.gz" | sha256sum -c -; \
    rm -rf /var/lib/apt/lists/*

# 3b) Fetch the PINNED offline OurAirports dataset (public domain), verify checksums, and gzip each CSV.
#     Same reproducibility contract as the aircraft DB: pin the git commit + sha256 so a swapped upstream
#     file fails the build. airports/runways/frequencies are joined at runtime by AirportDbService.
FROM debian:trixie-slim AS airportsdb
ENV DEBIAN_FRONTEND=noninteractive
ENV AIRPORTS_URL=https://raw.githubusercontent.com/davidmegginson/ourairports-data/580ac3fa001ea8e2e39a4c99520adf6e82c42442/airports.csv
ENV AIRPORTS_SHA256=b07861da436d22f3932567c4b39cd065e75adc8fc448aa08895491e5cf615781
ENV RUNWAYS_URL=https://raw.githubusercontent.com/davidmegginson/ourairports-data/580ac3fa001ea8e2e39a4c99520adf6e82c42442/runways.csv
ENV RUNWAYS_SHA256=4c13ee85aa746c255115f3d6bc1b2996f4fb307007a33ea19e29358225f88ad3
ENV FREQUENCIES_URL=https://raw.githubusercontent.com/davidmegginson/ourairports-data/580ac3fa001ea8e2e39a4c99520adf6e82c42442/airport-frequencies.csv
ENV FREQUENCIES_SHA256=0a127f9e41e6cc997e2b0b86d3bb44a336779777444f3fd298448647ac0c5cb4
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    mkdir -p /out; \
    curl -fsSL "$AIRPORTS_URL" -o /tmp/airports.csv; \
    curl -fsSL "$RUNWAYS_URL" -o /tmp/runways.csv; \
    curl -fsSL "$FREQUENCIES_URL" -o /tmp/airport-frequencies.csv; \
    echo "${AIRPORTS_SHA256}  /tmp/airports.csv" | sha256sum -c -; \
    echo "${RUNWAYS_SHA256}  /tmp/runways.csv" | sha256sum -c -; \
    echo "${FREQUENCIES_SHA256}  /tmp/airport-frequencies.csv" | sha256sum -c -; \
    gzip -9 -c /tmp/airports.csv > /out/airports.csv.gz; \
    gzip -9 -c /tmp/runways.csv > /out/runways.csv.gz; \
    gzip -9 -c /tmp/airport-frequencies.csv > /out/airport-frequencies.csv.gz; \
    rm -rf /var/lib/apt/lists/* /tmp/*.csv

# 4) Runtime — chiseled (distroless-style) base: no shell, no package manager, none of the Debian
#    userland packages Grype keeps flagging; same `-extra` variant (ICU + tzdata for culture/timezone
#    formatting) the ClutterStock API uses. Non-root by default (`app`, uid 1654 — the same uid the
#    k8s deployment already pins via runAsUser). Consequences: no `docker exec` shell into the
#    container, and any in-container healthcheck would need a sidecar (the e2e compose already
#    polls /healthz from a curl sidecar for exactly this reason).
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled-extra AS final
WORKDIR /app
COPY --from=backend /app/publish ./
COPY --from=aircraftdb /out/aircraft.csv.gz /app/data/aircraft.csv.gz
COPY --from=airportsdb /out/airports.csv.gz /app/data/airports.csv.gz
COPY --from=airportsdb /out/runways.csv.gz /app/data/runways.csv.gz
COPY --from=airportsdb /out/airport-frequencies.csv.gz /app/data/airport-frequencies.csv.gz
# appsettings.Development.json points the airports at test fixtures that aren't in the image, which left
# the airports layer empty in the Development-mode preview/e2e containers. Env vars win over it.
ENV Airports__AirportsPath=/app/data/airports.csv.gz
ENV Airports__RunwaysPath=/app/data/runways.csv.gz
ENV Airports__FrequenciesPath=/app/data/airport-frequencies.csv.gz
# Ports (OpenStreetMap for Norway, ODbL + World Port Index elsewhere), committed by
# data/ports/extract-osm-ports.mjs. The env var wins
# over appsettings.Development.json, so preview/e2e containers (Development) load it too.
COPY data/ports/ports.csv.gz /app/data/ports.csv.gz
ENV Ports__PortsPath=/app/data/ports.csv.gz
# Landmarks for AR identify (GeoNames peaks + populated places, CC BY 4.0), committed by
# data/landmarks/extract-geonames-landmarks.mjs. Same env-var override as the ports.
COPY data/landmarks/landmarks.csv.gz /app/data/landmarks.csv.gz
ENV Landmarks__LandmarksPath=/app/data/landmarks.csv.gz
# Elevation grids for the tiltable Radar's relief (ETOPO 2022, NOAA NCEI, public domain), committed by
# data/terrain/build-etopo-terrain.mjs. Same env-var override as the ports.
COPY data/terrain/terrain.bin.gz /app/data/terrain.bin.gz
ENV Terrain__TerrainPath=/app/data/terrain.bin.gz
# Public ADS-B capture replayed by Mqtt__Replay + Mqtt__ReplayFile in preview/e2e envs (never in prod;
# replay is gated on Development). ADS-B is broadcast data, so committing/baking the capture is fine.
COPY backend/tests/Api.Tests/fixtures/aircraft.json /app/fixtures/aircraft.json
# Public AIS capture replayed by Mqtt__AisReplay + Mqtt__AisReplayFile alongside the aircraft feed.
# AIS is broadcast data too, so baking the capture is fine (JSONL: one record per line, blank-separated).
COPY backend/tests/Api.Tests/fixtures/ais-capture.jsonl /app/fixtures/ais.jsonl
# Satellite fixtures for the Development-gated Satellites__TleFile / Satellites__TransmittersFile short-
# circuit (preview/e2e only — never contacted in prod). Public orbital data (CelesTrak) + transmitter
# data (SatNOGS DB, CC BY-SA), so baking them for previews/e2e is fine.
COPY backend/tests/Api.Tests/fixtures/tle.json /app/fixtures/tle.json
COPY backend/tests/Api.Tests/fixtures/transmitters.json /app/fixtures/transmitters.json

ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_RUNNING_IN_CONTAINER=true

# No USER needed: chiseled images already default to the non-root `app` user (uid 1654).
EXPOSE 8080
ENTRYPOINT ["dotnet", "Skylens.Api.dll"]
