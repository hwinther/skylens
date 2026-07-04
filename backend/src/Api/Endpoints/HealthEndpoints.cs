using Microsoft.AspNetCore.Http.HttpResults;
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
        app.MapGet("/healthz", Ok<HealthResponse> (IngestStatus status, TimeProvider time) =>
           {
               var now = time.GetUtcNow();
               var last = status.LastMessageAt;
               var ageSeconds = last is null ? (double?)null : (now - last.Value).TotalSeconds;
               var fresh = status.IsFresh(now);

               return TypedResults.Ok(new HealthResponse(
                   Status: fresh ? "healthy" : "degraded",
                   MqttConnected: status.Connected,
                   LastMessageAgeSeconds: ageSeconds,
                   AircraftCount: status.LastAircraftCount,
                   MessageCount: status.MessageCount,
                   Version: ApiBuildMetadata.Version));
           })
           .AllowAnonymous()
           .WithName("Healthz");

        return app;
    }

    /// <summary>Health payload. <c>degraded</c> when the last MQTT message is older than 30 s (or none yet).</summary>
    public sealed record HealthResponse(
        string Status,
        bool MqttConnected,
        double? LastMessageAgeSeconds,
        int AircraftCount,
        long MessageCount,
        string Version);
}
