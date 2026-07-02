using System.Security.Claims;
using Microsoft.AspNetCore.Http.HttpResults;
using Skylens.Api.Broadcast;
using Skylens.Api.Enrichment;
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
}
