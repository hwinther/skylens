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
RUN npm ci --omit=dev --no-audit --no-fund
COPY app/ ./
# Version metadata + force-live are compiled into the public JS bundle. NEVER add EXPO_PUBLIC_HOME_LAT/LON/ALT
# (secret home coordinates) and NO EXPO_PUBLIC_API_BASE_URL (the app resolves the gateway same-origin).
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ENV EXPO_PUBLIC_FORCE_LIVE=1 \
    EXPO_PUBLIC_APP_VERSION=$APP_VERSION \
    EXPO_PUBLIC_GIT_SHA=$GIT_SHA
RUN npx expo export --platform web

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

# 4) Runtime
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
COPY --from=backend /app/publish ./
COPY --from=aircraftdb /out/aircraft.csv.gz /app/data/aircraft.csv.gz
# Public ADS-B capture replayed by Mqtt__Replay + Mqtt__ReplayFile in preview/e2e envs (never in prod;
# replay is gated on Development). ADS-B is broadcast data, so committing/baking the capture is fine.
COPY backend/tests/Api.Tests/fixtures/aircraft.json /app/fixtures/aircraft.json

ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_RUNNING_IN_CONTAINER=true

# Non-root (the aspnet image ships an `app` user as $APP_UID=1654).
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Skylens.Api.dll"]
