using Microsoft.AspNetCore.Http.HttpResults;
using Skylens.Api.Enrichment;
using Skylens.Api.Extensions;
using Skylens.Api.State;

namespace Skylens.Api.Endpoints;

/// <summary>
///     Anonymous <c>/healthz</c>. Reports MQTT ingest freshness from the shared <see cref="IngestStatus" />.
///     Must always respond — never crash — even when the broker is unreachable: a stale or never-connected
///     feed is reported as <c>degraded</c> (HTTP 200 so k8s liveness stays up; the app is running, just
///     starved of data), not a 5xx.
/// </summary>
public static class HealthEndpoints
{
    public static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/healthz", Ok<HealthResponse> (IngestStatus status, VesselIngestStatus vesselStatus,
                                                   CelestrakTleService tle, TimeProvider time) =>
           {
               var now = time.GetUtcNow();
               var last = status.LastMessageAt;
               var ageSeconds = last is null ? (double?)null : (now - last.Value).TotalSeconds;
               var fresh = status.IsFresh(now);

               // AIS rides the same MQTT connection, so it reuses the aircraft feed's connected flag. Its
               // freshness is tracked separately (15-min threshold) and reported additively — it must NOT
               // influence the top-level Status, which stays aircraft-only for probes/dashboards.
               var aisLast = vesselStatus.LastMessageAt;
               var aisAgeSeconds = aisLast is null ? (double?)null : (now - aisLast.Value).TotalSeconds;

               // Satellite TLE freshness, reported additively like the AIS fields (never influences Status).
               // Read the already-fetched snapshot's metadata ONLY — a probe must never trigger CelesTrak's
               // lazy fetch (it stays cheap and offline-safe). Pre-fetch: count 0, age null, stale=true.
               var tleFetchedAt = tle.FetchedAt;
               var tleAgeSeconds = tleFetchedAt is null ? (double?)null : (now - tleFetchedAt.Value).TotalSeconds;
               var tleStale = tleAgeSeconds is null || tleAgeSeconds > TleStaleThreshold.TotalSeconds;

               return TypedResults.Ok(new HealthResponse(
                   Status: fresh ? "healthy" : "degraded",
                   MqttConnected: status.Connected,
                   LastMessageAgeSeconds: ageSeconds,
                   AircraftCount: status.LastAircraftCount,
                   MessageCount: status.MessageCount,
                   Version: ApiBuildMetadata.Version,
                   AisConnected: status.Connected,
                   VesselCount: vesselStatus.LastVesselCount,
                   AisLastMessageAgeSeconds: aisAgeSeconds,
                   AisStale: !vesselStatus.IsFresh(now),
                   SatelliteCount: tle.Count,
                   TleAgeSeconds: tleAgeSeconds,
                   TleStale: tleStale));
           })
           .AllowAnonymous()
           .WithName("Healthz");

        return app;
    }

    /// <summary>TLE elements older than this (or never fetched) are reported stale on healthz.</summary>
    private static readonly TimeSpan TleStaleThreshold = TimeSpan.FromHours(12);

    /// <summary>
    ///     Health payload. Top-level <c>Status</c> is <c>degraded</c> when the last aircraft MQTT message
    ///     is older than 30 s (or none yet) — unchanged, and deliberately independent of the AIS and
    ///     satellite fields. The <c>Ais*</c> fields report the vessel feed additively (<c>AisStale</c> uses a
    ///     15-min threshold); the <c>Satellite*</c>/<c>Tle*</c> fields report CelesTrak freshness additively
    ///     (<c>TleStale</c> uses a 12-hour threshold and is true before the first fetch).
    /// </summary>
    public sealed record HealthResponse(
        string Status,
        bool MqttConnected,
        double? LastMessageAgeSeconds,
        int AircraftCount,
        long MessageCount,
        string Version,
        bool AisConnected,
        int VesselCount,
        double? AisLastMessageAgeSeconds,
        bool AisStale,
        int SatelliteCount,
        double? TleAgeSeconds,
        bool TleStale);
}
