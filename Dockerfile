# syntax=docker/dockerfile:1
#
# Single image for the skylens backend gateway: ASP.NET Core 10 Minimal API + SignalR, with the
# pinned wiedehopf/tar1090-db aircraft.csv.gz baked in for offline registration/type enrichment.
# Pure .NET — multi-arch OK (no native binaries).

# 1) Publish the API -> /app/publish
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS backend
WORKDIR /src
COPY backend/ ./backend/
RUN dotnet publish backend/src/Api/Api.csproj -c Release -o /app/publish /p:UseAppHost=false

# 2) Fetch the PINNED offline aircraft DB and verify its checksum. Pinning the git commit + sha256
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

# 3) Runtime
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
COPY --from=backend /app/publish ./
COPY --from=aircraftdb /out/aircraft.csv.gz /app/data/aircraft.csv.gz

ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_RUNNING_IN_CONTAINER=true

# Non-root (the aspnet image ships an `app` user as $APP_UID=1654).
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Skylens.Api.dll"]
