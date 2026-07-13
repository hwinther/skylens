using System.Security.Claims;
using Microsoft.AspNetCore.Http.HttpResults;
using Skylens.Api.Broadcast;
using Skylens.Api.Enrichment;
using Skylens.Api.Extensions;
using Skylens.Api.Ingest;
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

        // GET /api/vessels[?lat=&lon=&radiusKm=&kind=] — current AIS picture, optionally radius-filtered
        // and/or restricted to a kind ("ship"/"aton", case-insensitive). Uses the group's "global" limit.
        api.MapGet("/vessels",
                   Ok<IReadOnlyList<VesselDto>> (VesselStateStore store, TimeProvider time,
                                                 double? lat, double? lon, double? radiusKm, string? kind) =>
                   {
                       var now = time.GetUtcNow();
                       var all = store.Snapshot();
                       IEnumerable<VesselState> filtered = all;

                       if (lat is { } la && lon is { } lo)
                       {
                           var r = Math.Clamp(radiusKm ?? 300, 1, 500);
                           filtered = filtered.Where(v => v.HasPosition &&
                                                          Geo.DistanceKm(la, lo, v.Lat!.Value, v.Lon!.Value) <= r);
                       }

                       // Only "ship"/"aton" filter; any other value is ignored (returns the unfiltered kinds).
                       if (kind is { Length: > 0 } &&
                           (string.Equals(kind, "ship", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(kind, "aton", StringComparison.OrdinalIgnoreCase)))
                       {
                           var wantAton = string.Equals(kind, "aton", StringComparison.OrdinalIgnoreCase);
                           filtered = filtered.Where(v => (v.Kind == VesselKind.Aton) == wantAton);
                       }

                       var dtos = filtered.Select(v => VesselDto.FromState(v, now)).ToArray();
                       return TypedResults.Ok<IReadOnlyList<VesselDto>>(dtos);
                   })
           .WithName("VesselList");

        // GET /api/vessels/{mmsi} — live AIS state (if tracked) + resolved static metadata. The live feed's
        // own static/voyage data wins; BarentsWatch fills the gaps (and covers away-mode vessels we don't
        // track locally at all). BarentsWatch is only queried when the local feed hasn't supplied static
        // data yet — mirroring how /api/aircraft/{hex} only falls back to OpenSky on an offline-DB miss —
        // so a fully-tracked vessel spends no upstream budget. Both halves absent → 404. Stays on the
        // group's "global" rate limit like /api/aircraft/{hex} (its OpenSky fallback isn't on "enrichment").
        api.MapGet("/vessels/{mmsi}",
                   async Task<Results<Ok<VesselDetail>, NotFound>> (
                       string mmsi,
                       VesselStateStore store,
                       BarentsWatchClient barentsWatch,
                       FiskInfoClient fiskInfo,
                       TimeProvider time,
                       CancellationToken ct) =>
                   {
                       store.TryGet(mmsi, out var state);
                       var local = state is null ? null : VesselMetadata.FromState(state);

                       var upstream = HasStaticData(local) ? null : await barentsWatch.LookupAsync(mmsi, ct);
                       var metadata = MergeVesselMetadata(local, upstream);

                       // FiskInfo NOR/NIS ship-register enrichment (name/owner/type/length) folded into the
                       // same single fetch. Fail-soft: null when FiskInfo is unconfigured or the MMSI isn't
                       // in the register, cached 7 d per MMSI. It can also surface register-only info for an
                       // MMSI we neither track nor cover via BarentsWatch (turning a would-be 404 into a 200).
                       var register = await fiskInfo.LookupShipRegisterAsync(mmsi, ct);
                       metadata = ApplyShipRegister(metadata, register, mmsi);

                       if (state is null && metadata is null)
                           return TypedResults.NotFound();

                       var dto = state is null ? null : VesselDto.FromState(state, time.GetUtcNow());
                       return TypedResults.Ok(new VesselDetail(dto, metadata));
                   })
           .WithName("VesselDetail");

        // GET /api/satellites — every satellite in the current CelesTrak TLE snapshot (orbital elements for
        // client-side SGP4) plus an optional SatNOGS downlink summary. Cold start: the FIRST call triggers
        // CelesTrak's synchronous fetch; if that has never produced a snapshot the endpoint fails soft with a
        // 503 + reason (mirrors /api/area surfacing its LastReason). SatNOGS is fail-soft — an unavailable
        // transmitter DB just leaves FreqSummary null. Stays on the group's "global" rate limit: no
        // per-request upstream spend beyond the shared cached snapshots, same reasoning as /api/aircraft/{hex}.
        api.MapGet("/satellites",
                   async Task<Results<Ok<SatelliteListResponse>, ProblemHttpResult>> (
                       CelestrakTleService tle,
                       SatNogsClient satNogs,
                       TimeProvider time,
                       CancellationToken ct) =>
                   {
                       var snap = await tle.GetAsync(ct);
                       if (snap is null)
                           return TypedResults.Problem(
                               detail: tle.LastReason ?? "tle-unavailable",
                               statusCode: StatusCodes.Status503ServiceUnavailable);

                       // Fail-soft: an unavailable SatNOGS DB just leaves every FreqSummary null.
                       await satNogs.GetAsync(ct);

                       var satellites = snap.Records
                                            .Select(r => new SatelliteDto(
                                                        r.Omm.NoradCatId, r.Omm.ObjectName, r.AppGroup,
                                                        satNogs.FreqSummary(r.Omm.NoradCatId), r.Omm))
                                            .ToArray();

                       var ageSeconds = (time.GetUtcNow() - snap.FetchedAt).TotalSeconds;
                       return TypedResults.Ok(new SatelliteListResponse(snap.FetchedAt, ageSeconds, satellites));
                   })
           .WithName("SatelliteList");

        // GET /api/satellites/{noradId} — one satellite's elements + its full SatNOGS transmitter list. 404
        // when the id isn't in the current snapshot (or nothing has been fetched yet). An empty transmitter
        // list is fine. Same "global" limit / no extra upstream spend as the list endpoint.
        api.MapGet("/satellites/{noradId:int}",
                   async Task<Results<Ok<SatelliteDetail>, NotFound>> (
                       int noradId,
                       CelestrakTleService tle,
                       SatNogsClient satNogs,
                       CancellationToken ct) =>
                   {
                       var snap = await tle.GetAsync(ct);
                       var record = snap?.Records.FirstOrDefault(r => r.Omm.NoradCatId == noradId);
                       if (record is null)
                           return TypedResults.NotFound();

                       var byNorad = await satNogs.GetAsync(ct);
                       var transmitters = byNorad.TryGetValue(noradId, out var t)
                           ? t
                           : (IReadOnlyList<SatelliteTransmitterDto>)[];

                       var dto = new SatelliteDto(
                           record.Omm.NoradCatId, record.Omm.ObjectName, record.AppGroup,
                           satNogs.FreqSummary(noradId), record.Omm);
                       return TypedResults.Ok(new SatelliteDetail(dto, transmitters));
                   })
           .WithName("SatelliteDetail");

        // GET /api/fishing/zones — combined fishing-regulation zones (coastal cod + forbidden + zero) from
        // BarentsWatch FiskInfo, each carrying its raw GeoJSON `geometry` verbatim for the map layer. When
        // FiskInfo is UNconfigured this returns 200 with an empty list + a note (so the layer degrades to
        // "nothing to show"); a 503 + reason is only surfaced when FiskInfo IS configured but NOTHING could
        // be fetched. Partial upstream failures still return the datasets that succeeded. Cached 12 h, so no
        // per-request upstream spend — stays on the group's "global" rate limit.
        api.MapGet("/fishing/zones",
                   async Task<Results<Ok<FishingZonesResponse>, ProblemHttpResult>> (
                       FiskInfoClient fiskInfo,
                       TimeProvider time,
                       CancellationToken ct) =>
                   {
                       if (!fiskInfo.Configured)
                           return TypedResults.Ok(
                               new FishingZonesResponse(time.GetUtcNow(), [], "fiskinfo-unconfigured"));

                       var zones = await fiskInfo.GetZonesAsync(ct);
                       if (zones is null)
                           return TypedResults.Problem(
                               detail: fiskInfo.LastReason ?? "fiskinfo-unavailable",
                               statusCode: StatusCodes.Status503ServiceUnavailable);

                       return TypedResults.Ok(new FishingZonesResponse(zones.FetchedAt, zones.Zones, null));
                   })
           .WithName("FishingZones");

        // GET /api/fishing/lostgear — lost/ghost fishing gear still in the water (anonymized for regular
        // users), point geometry passed through verbatim. Same unconfigured-empty / configured-failed-503
        // behavior as /api/fishing/zones. Cached 3 h; stays on the group's "global" rate limit.
        api.MapGet("/fishing/lostgear",
                   async Task<Results<Ok<LostGearResponse>, ProblemHttpResult>> (
                       FiskInfoClient fiskInfo,
                       TimeProvider time,
                       CancellationToken ct) =>
                   {
                       if (!fiskInfo.Configured)
                           return TypedResults.Ok(
                               new LostGearResponse(time.GetUtcNow(), [], "fiskinfo-unconfigured"));

                       var gear = await fiskInfo.GetLostGearAsync(ct);
                       if (gear is null)
                           return TypedResults.Problem(
                               detail: fiskInfo.LastReason ?? "fiskinfo-unavailable",
                               statusCode: StatusCodes.Status503ServiceUnavailable);

                       return TypedResults.Ok(new LostGearResponse(time.GetUtcNow(), gear, null));
                   })
           .WithName("FishingLostGear");

        return app;
    }

    /// <summary>True when the local feed already carries static/voyage data (so no upstream lookup helps).</summary>
    internal static bool HasStaticData(VesselMetadata? m) =>
        m is not null &&
        (m.CallSign is not null || m.Imo is not null || m.Destination is not null ||
         m.Eta is not null || m.Draught is not null || m.DimBow is not null);

    /// <summary>Field-merge two metadata halves: the local (state-derived) value wins, upstream fills nulls.</summary>
    internal static VesselMetadata? MergeVesselMetadata(VesselMetadata? local, VesselMetadata? upstream)
    {
        if (local is null)
            return upstream;
        if (upstream is null)
            return local;

        return local with
        {
            Flag = local.Flag ?? upstream.Flag,
            CallSign = local.CallSign ?? upstream.CallSign,
            Imo = local.Imo ?? upstream.Imo,
            Destination = local.Destination ?? upstream.Destination,
            Eta = local.Eta ?? upstream.Eta,
            Draught = local.Draught ?? upstream.Draught,
            ShipTypeText = local.ShipTypeText ?? upstream.ShipTypeText,
            DimBow = local.DimBow ?? upstream.DimBow,
            DimStern = local.DimStern ?? upstream.DimStern,
            DimPort = local.DimPort ?? upstream.DimPort,
            DimStarboard = local.DimStarboard ?? upstream.DimStarboard,
        };
    }

    /// <summary>
    ///     Fold FiskInfo NOR/NIS ship-register info into the vessel metadata: the register-specific fields
    ///     (name/owner/type/length overall) are always set from the register, and IMO/call sign fill any
    ///     still-null AIS values. A register hit for an MMSI with no other metadata materializes a
    ///     register-only <see cref="VesselMetadata" />; a null register is a no-op (fail-soft).
    /// </summary>
    internal static VesselMetadata? ApplyShipRegister(VesselMetadata? metadata, ShipRegister? register, string mmsi)
    {
        if (register is null)
            return metadata;

        metadata ??= new VesselMetadata { Mmsi = mmsi };
        return metadata with
        {
            Imo = metadata.Imo ?? register.Imo,
            CallSign = metadata.CallSign ?? register.CallSign,
            RegisterName = register.Name,
            RegisterOwner = register.Owner,
            RegisterType = register.VesselType,
            RegisterLengthOverall = register.LengthOverall,
        };
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

    public sealed record VesselDetail(VesselDto? State, VesselMetadata? Metadata);

    /// <summary>
    ///     GET /api/fishing/zones — combined fishing-regulation zones with their fetch time. Each
    ///     <see cref="FishingZone" /> carries a <c>kind</c> ("cod"/"forbidden"/"zero"), optional info, and
    ///     the raw GeoJSON <c>geometry</c> verbatim. <see cref="Note" /> is set (and <see cref="Zones" />
    ///     empty) only when FiskInfo is unconfigured.
    /// </summary>
    public sealed record FishingZonesResponse(
        DateTimeOffset FetchedAtUtc, IReadOnlyList<FishingZone> Zones, string? Note);

    /// <summary>
    ///     GET /api/fishing/lostgear — lost/ghost fishing gear points with their fetch time.
    ///     <see cref="Note" /> is set (and <see cref="Gear" /> empty) only when FiskInfo is unconfigured.
    /// </summary>
    public sealed record LostGearResponse(
        DateTimeOffset FetchedAtUtc, IReadOnlyList<LostGear> Gear, string? Note);

    /// <summary>
    ///     GET /api/satellites — the whole current snapshot: when CelesTrak last built it,
    ///     how old it is now (<see cref="TleAgeSeconds" />, for the client to age-fade propagated
    ///     positions), and every satellite mapped to a <see cref="SatelliteDto" />.
    /// </summary>
    public sealed record SatelliteListResponse(
        DateTimeOffset FetchedAtUtc, double TleAgeSeconds, IReadOnlyList<SatelliteDto> Satellites);

    /// <summary>GET /api/satellites/{noradId} — one satellite plus its full SatNOGS transmitter list.</summary>
    public sealed record SatelliteDetail(SatelliteDto Satellite, IReadOnlyList<SatelliteTransmitterDto> Transmitters);

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
