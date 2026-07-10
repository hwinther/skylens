using System.Security.Claims;
using Microsoft.AspNetCore.Http.HttpResults;
using Skylens.Api.Broadcast;
using Skylens.Api.Enrichment;
using Skylens.Api.Extensions;
using Skylens.Api.State;

namespace Skylens.Api.Endpoints;

/// <summary>
///     JWT-protected REST surface under <c>/api</c>. The group carries the default fallback authorization
///     (RequireAuthenticatedUser) plus the <c>global</c> rate-limit policy; the two enrichment endpoints
///     add the tighter <c>enrichment</c> policy and an audit-log scope (sub + preferred_username).
/// </summary>
public static class ApiEndpoints
{
    public static IEndpointRouteBuilder MapApiEndpoints(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api")
                     .RequireAuthorization()
                     .RequireRateLimiting("global");

        // GET /api/version — build version + git sha baked in at publish (empty sha in local dev).
        api.MapGet("/version", () => TypedResults.Ok(new VersionResponse(
                                                         Version: ApiBuildMetadata.Version,
                                                         Sha: ApiBuildMetadata.Sha)))
           .WithName("Version");

        // POST /api/client-log — the app posts summaries of its OWN failed requests so client-side
        // failures land in the backend logs (→ OTLP → Loki → Grafana). AllowAnonymous is the whole
        // point: it must capture failures that happen without a token (auth failures, edge blocks).
        // Bounded (MaxEntries) and rate-limited by the group's per-IP "global" bucket so an anonymous
        // endpoint can't be used to flood logs.
        api.MapPost("/client-log",
                    (ClientLogBatch batch, ILoggerFactory loggerFactory) =>
                    {
                        var log = loggerFactory.CreateLogger("Skylens.Api.ClientLog");
                        foreach (var e in (batch.Entries ?? []).Take(ClientLogBatch.MaxEntries))
                            log.LogWarning(
                                "client-reported failure: {Method} {Endpoint} status={Status} edgeMarker={EdgeMarker} ua={ClientUserAgent} detail={Detail}",
                                Truncate(e.Method, 8), Truncate(e.Endpoint, 200), e.Status,
                                e.EdgeMarkerPresent, Truncate(e.UserAgent, 120), Truncate(e.Detail, 500));
                        return TypedResults.NoContent();
                    })
           .AllowAnonymous()
           .WithName("ClientLog");

        // GET /api/me — echo the caller's identity claims.
        api.MapGet("/me", (ClaimsPrincipal user) => TypedResults.Ok(new MeResponse(
                                                                        Sub: user.Sub(),
                                                                        PreferredUsername: user.PreferredUsername(),
                                                                        Groups: user.Groups())))
           .WithName("Me");

        // GET /api/aircraft[?lat=&lon=&radiusKm=] — current picture, optionally filtered to a radius.
        api.MapGet("/aircraft",
                   Ok<IReadOnlyList<AircraftDto>> (AircraftStateStore store,
                                                   double? lat, double? lon, double? radiusKm) =>
                   {
                       var all = store.Snapshot();
                       IEnumerable<AircraftState> filtered = all;

                       if (lat is { } la && lon is { } lo)
                       {
                           var r = Math.Clamp(radiusKm ?? 300, 1, 500);
                           filtered = all.Where(a => a.HasPosition &&
                                                     Geo.DistanceKm(la, lo, a.Lat!.Value, a.Lon!.Value) <= r);
                       }

                       var dtos = filtered.Select(static a => AircraftDto.FromState(a)).ToArray();
                       return TypedResults.Ok<IReadOnlyList<AircraftDto>>(dtos);
                   })
           .WithName("AircraftList");

        // GET /api/aircraft/{hex} — live state (if tracked) + resolved metadata.
        api.MapGet("/aircraft/{hex}",
                   async Task<Results<Ok<AircraftDetail>, NotFound>> (string hex,
                                                                      AircraftStateStore store,
                                                                      MetadataService metadata,
                                                                      CancellationToken ct) =>
                   {
                       var key = hex.ToLowerInvariant();
                       store.TryGet(key, out var state);
                       var meta = await metadata.GetAsync(key, ct);

                       if (state is null && meta is null)
                           return TypedResults.NotFound();

                       var dto = state is null ? null : AircraftDto.FromState(state);
                       return TypedResults.Ok(new AircraftDetail(dto, meta));
                   })
           .WithName("AircraftDetail");

        // GET /api/aircraft/{hex}/route — AeroAPI route by callsign. On-tap only; tight budget/rate limit.
        api.MapGet("/aircraft/{hex}/route",
                   async Task<Results<Ok<FlightRoute>, ProblemHttpResult, NotFound>> (
                       string hex,
                       AircraftStateStore store,
                       AeroApiClient aeroApi,
                       ClaimsPrincipal user,
                       ILoggerFactory loggerFactory,
                       CancellationToken ct) =>
                   {
                       using var _ = BeginAuditScope(loggerFactory, "aircraft-route", user);

                       if (!store.TryGet(hex.ToLowerInvariant(), out var state) || state?.Flight is null)
                           return TypedResults.NotFound();

                       var route = await aeroApi.GetRouteAsync(state.Flight, ct);
                       if (route is not null)
                           return TypedResults.Ok(route);

                       // Budget/unconfigured/upstream reasons surface as a 503 with the reason; not-found → 404.
                       return aeroApi.LastReason == "not-found"
                           ? TypedResults.NotFound()
                           : TypedResults.Problem(
                               detail: aeroApi.LastReason ?? "route-unavailable",
                               statusCode: StatusCodes.Status503ServiceUnavailable);
                   })
           .RequireRateLimiting("enrichment")
           .WithName("AircraftRoute");

        // GET /api/aircraft/{hex}/route/cached — the route only if it's ALREADY cached; never fetches or
        // spends AeroAPI budget, so it's safe to auto-load on detail open (the on-tap-only rule protects
        // the paid /route above, not this). 204 when nothing is cached yet. Uses the group's "global"
        // rate limit, not the tight "enrichment" one, so auto-loads don't compete with paid /route taps.
        api.MapGet("/aircraft/{hex}/route/cached",
                   Results<Ok<FlightRoute>, NoContent, NotFound> (string hex,
                                                                  AircraftStateStore store,
                                                                  AeroApiClient aeroApi) =>
                   {
                       if (!store.TryGet(hex.ToLowerInvariant(), out var state) || state?.Flight is null)
                           return TypedResults.NotFound();

                       var route = aeroApi.GetCachedRoute(state.Flight);
                       return route is not null ? TypedResults.Ok(route) : TypedResults.NoContent();
                   })
           .WithName("AircraftRouteCached");

        // GET /api/area?lat=&lon=&radiusKm= — ADSBx point-radius (away-mode coverage). Tight budget/rate limit.
        api.MapGet("/area",
                   async Task<Results<Ok<IReadOnlyList<AircraftDto>>, ProblemHttpResult>> (
                       double lat, double lon, double? radiusKm,
                       AdsbxClient adsbx,
                       ClaimsPrincipal user,
                       ILoggerFactory loggerFactory,
                       CancellationToken ct) =>
                   {
                       using var _ = BeginAuditScope(loggerFactory, "area", user);

                       var r = Math.Clamp(radiusKm ?? 300, 1, 500);
                       var result = await adsbx.GetAsync(lat, lon, r, ct);
                       if (result.StatusReason is not null)
                           return TypedResults.Problem(
                               detail: result.StatusReason,
                               statusCode: StatusCodes.Status503ServiceUnavailable);

                       return TypedResults.Ok(result.Aircraft);
                   })
           .RequireRateLimiting("enrichment")
           .WithName("Area");

        return app;
    }

    private static IDisposable? BeginAuditScope(ILoggerFactory loggerFactory, string action, ClaimsPrincipal user) =>
        loggerFactory.CreateLogger("Skylens.Api.Enrichment.Audit")
                     .BeginScope(new Dictionary<string, object?>
                     {
                         ["action"] = action,
                         ["sub"] = user.Sub(),
                         ["preferred_username"] = user.PreferredUsername(),
                     });

    public sealed record MeResponse(string? Sub, string? PreferredUsername, string[] Groups);

    public sealed record AircraftDetail(AircraftDto? State, AircraftMetadata? Metadata);

    public sealed record VersionResponse(string Version, string Sha);

    private static string Truncate(string? value, int max) =>
        string.IsNullOrEmpty(value) ? "" : value.Length <= max ? value : value[..max];

    /// <summary>One client-reported request failure (a summary the app sends, not the payload).</summary>
    public sealed record ClientLogEntry(
        string? Method, string? Endpoint, int? Status, bool EdgeMarkerPresent, string? UserAgent, string? Detail);

    /// <summary>A batch of client failures flushed together; capped server-side at <see cref="MaxEntries" />.</summary>
    public sealed record ClientLogBatch(ClientLogEntry[]? Entries)
    {
        public const int MaxEntries = 50;
    }
}
