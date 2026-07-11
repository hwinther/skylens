using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using Skylens.Api.Broadcast;
using Skylens.Api.Options;
using Skylens.Api.State;

namespace Skylens.Api.Enrichment;

/// <summary>
///     BarentsWatch Live AIS away-mode source (official Norwegian AIS). Authenticates with OAuth2
///     client-credentials (scope "ais"), caching the token until shortly before expiry exactly like
///     <see cref="OpenSkyMetadataClient" />. Away-mode mirrors <see cref="AdsbxClient" />'s shape but with
///     a single Norway-wide snapshot instead of per-cell fetches: <c>GET /v1/latest/combined</c> is fetched
///     at most once per <see cref="SnapshotTtl" /> (shared across all viewers behind a single-flight gate,
///     one <see cref="UpstreamBudget" /> unit per fetch — cache hits are free), then geo-filtered per viewer
///     to the nearest <see cref="VesselBroadcaster.MaxVessels" />. <see cref="LookupAsync" /> serves
///     static/voyage enrichment for <c>/api/vessels/{mmsi}</c>, cached 6 h per MMSI. The budget fails closed
///     with a user-visible reason; an unconfigured client yields an empty list + reason (never throws).
/// </summary>
public sealed class BarentsWatchClient : IVesselAwayModeSource
{
    /// <summary>Norway-wide snapshot is refetched at most this often; positions move slowly.</summary>
    private static readonly TimeSpan SnapshotTtl = TimeSpan.FromSeconds(60);

    /// <summary>Static/voyage data changes slowly, so per-MMSI lookups cache for 6 h.</summary>
    private static readonly TimeSpan LookupCacheTtl = TimeSpan.FromHours(6);

    private readonly HttpClient _http;
    private readonly BarentsWatchOptions _options;
    private readonly EnrichmentCache _cache;
    private readonly UpstreamBudget _budget;
    private readonly TimeProvider _time;
    private readonly ILogger<BarentsWatchClient> _logger;

    private readonly SemaphoreSlim _tokenGate = new(1, 1);
    private readonly SemaphoreSlim _snapshotGate = new(1, 1);

    private string? _token;
    private DateTimeOffset _tokenExpiry;
    private SnapshotCache? _snapshot;

    public BarentsWatchClient(
        HttpClient http,
        IOptions<BarentsWatchOptions> options,
        EnrichmentCache cache,
        [FromKeyedServices("barentswatch")] UpstreamBudget budget,
        TimeProvider time,
        ILogger<BarentsWatchClient> logger)
    {
        _http = http;
        _options = options.Value;
        _cache = cache;
        _budget = budget;
        _time = time;
        _logger = logger;
    }

    public bool Configured => _options.Configured;

    public UpstreamBudget Budget => _budget;

    /// <summary>
    ///     Away-mode: serve every BarentsWatch vessel within the viewer radius (nearest-first, capped).
    ///     A fresh cached snapshot is served without touching the budget; otherwise one fetch is made under
    ///     the single-flight gate and costs one budget unit. Fails closed with a reason (never throws).
    /// </summary>
    public async Task<VesselAwayResult> GetAsync(double lat, double lon, double radiusKm, CancellationToken ct)
    {
        if (!Configured)
            return new VesselAwayResult([], "away-mode-unconfigured");

        var now = _time.GetUtcNow();
        if (_snapshot is { } fresh && now - fresh.FetchedAt < SnapshotTtl)
            return FilterToRadius(fresh.Vessels, lat, lon, radiusKm);

        await _snapshotGate.WaitAsync(ct);
        try
        {
            now = _time.GetUtcNow();
            if (_snapshot is { } cached && now - cached.FetchedAt < SnapshotTtl)
                return FilterToRadius(cached.Vessels, lat, lon, radiusKm);

            if (!_budget.TryConsume())
            {
                _logger.LogWarning("BarentsWatch daily budget exhausted ({Used}/{Limit})", _budget.Used, _budget.Limit);
                return new VesselAwayResult([], "barentswatch-budget-exhausted");
            }

            var vessels = await FetchSnapshotAsync(ct);
            if (vessels is null)
                return new VesselAwayResult([], "barentswatch-unavailable");

            _snapshot = new SnapshotCache(_time.GetUtcNow(), vessels);
            return FilterToRadius(vessels, lat, lon, radiusKm);
        }
        finally
        {
            _snapshotGate.Release();
        }
    }

    /// <summary>
    ///     Static/voyage metadata for one MMSI (identity, callsign, IMO, destination, ETA, draught, dims).
    ///     Cached 6 h with single-flight; the upstream <c>POST /v1/latest/combined</c> costs one budget unit
    ///     on a miss. Returns null when unconfigured, over budget, or the MMSI isn't in coverage.
    /// </summary>
    public async Task<VesselMetadata?> LookupAsync(string mmsi, CancellationToken ct)
    {
        if (!Configured)
            return null;
        if (!long.TryParse(mmsi, NumberStyles.Integer, CultureInfo.InvariantCulture, out var numeric))
            return null;

        return await _cache.GetOrCreateAsync(
            $"bw:mmsi:{numeric}",
            LookupCacheTtl,
            async innerCt =>
            {
                if (!_budget.TryConsume())
                {
                    _logger.LogWarning("BarentsWatch daily budget exhausted ({Used}/{Limit})", _budget.Used, _budget.Limit);
                    return null;
                }

                return await FetchStaticAsync(numeric, innerCt);
            },
            ct);
    }

    private async Task<IReadOnlyList<VesselDto>?> FetchSnapshotAsync(CancellationToken ct)
    {
        try
        {
            var token = await GetTokenAsync(ct);
            if (token is null)
                return null;

            using var req = new HttpRequestMessage(HttpMethod.Get,
                $"{_options.BaseUrl}/v1/latest/combined?modelType=Full&modelFormat=Json");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

            using var resp = await _http.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("BarentsWatch latest/combined returned {Status}", resp.StatusCode);
                return null;
            }

            var payload = await resp.Content.ReadFromJsonAsync<List<BwCombined>>(ct);
            if (payload is null)
                return [];

            var now = _time.GetUtcNow();
            var result = new List<VesselDto>(payload.Count);
            foreach (var c in payload)
            {
                var dto = ToDto(c, now);
                if (dto is not null)
                    result.Add(dto);
            }

            return result;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "BarentsWatch snapshot fetch failed");
            return null;
        }
    }

    private async Task<VesselMetadata?> FetchStaticAsync(long mmsi, CancellationToken ct)
    {
        try
        {
            var token = await GetTokenAsync(ct);
            if (token is null)
                return null;

            // POST /v1/latest/combined with a single-MMSI filter body (per the Live AIS OpenAPI's
            // CombinedFilterInput). The response is a — 0-or-1 element — array of the combined model.
            using var req = new HttpRequestMessage(HttpMethod.Post,
                $"{_options.BaseUrl}/v1/latest/combined?modelType=Full&modelFormat=Json")
            {
                Content = JsonContent.Create(new BwFilter(mmsi)),
            };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

            using var resp = await _http.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("BarentsWatch latest/combined (mmsi {Mmsi}) returned {Status}", mmsi, resp.StatusCode);
                return null;
            }

            var payload = await resp.Content.ReadFromJsonAsync<List<BwCombined>>(ct);
            var c = payload?.FirstOrDefault(x => x.Mmsi == mmsi) ?? payload?.FirstOrDefault();
            return c is null ? null : ToMetadata(c);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "BarentsWatch static lookup failed for {Mmsi}", mmsi);
            return null;
        }
    }

    private async Task<string?> GetTokenAsync(CancellationToken ct)
    {
        // Refresh a minute before expiry (mirrors OpenSkyMetadataClient).
        if (_token is not null && _time.GetUtcNow() < _tokenExpiry - TimeSpan.FromMinutes(1))
            return _token;

        await _tokenGate.WaitAsync(ct);
        try
        {
            if (_token is not null && _time.GetUtcNow() < _tokenExpiry - TimeSpan.FromMinutes(1))
                return _token;

            using var req = new HttpRequestMessage(HttpMethod.Post, _options.TokenEndpoint)
            {
                Content = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["grant_type"] = "client_credentials",
                    ["client_id"] = _options.ClientId!,
                    ["client_secret"] = _options.ClientSecret!,
                    ["scope"] = "ais",
                }),
            };

            using var resp = await _http.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("BarentsWatch token endpoint returned {Status}", resp.StatusCode);
                return null;
            }

            var token = await resp.Content.ReadFromJsonAsync<OAuthTokenDto>(ct);
            if (token?.AccessToken is null)
                return null;

            _token = token.AccessToken;
            _tokenExpiry = _time.GetUtcNow().AddSeconds(token.ExpiresIn > 0 ? token.ExpiresIn : 3600);
            return _token;
        }
        finally
        {
            _tokenGate.Release();
        }
    }

    /// <summary>Geo-filter a snapshot to the viewer radius, nearest-first, capped like the own-feed loop.</summary>
    private static VesselAwayResult FilterToRadius(IReadOnlyList<VesselDto> vessels, double lat, double lon, double radiusKm)
    {
        var within = new List<(double DistKm, VesselDto Vessel)>();
        foreach (var v in vessels)
        {
            if (v.Lat is null || v.Lon is null)
                continue;
            var dist = Geo.DistanceKm(lat, lon, v.Lat.Value, v.Lon.Value);
            if (dist <= radiusKm)
                within.Add((dist, v));
        }

        within.Sort(static (a, b) => a.DistKm.CompareTo(b.DistKm));

        var count = Math.Min(within.Count, VesselBroadcaster.MaxVessels);
        var result = new List<VesselDto>(count);
        for (var i = 0; i < count; i++)
            result.Add(within[i].Vessel);

        return new VesselAwayResult(result, null);
    }

    private VesselDto? ToDto(BwCombined c, DateTimeOffset now)
    {
        if (c.Latitude is null || c.Longitude is null)
            return null;

        return new VesselDto
        {
            Mmsi = c.Mmsi.ToString(CultureInfo.InvariantCulture),
            Name = Blank(c.Name),
            // The combined snapshot is vessel position+static only; AtoN is a separate message type.
            Kind = "ship",
            Lat = c.Latitude,
            Lon = c.Longitude,
            Sog = c.SpeedOverGround,
            Cog = c.CourseOverGround,
            Hdg = c.TrueHeading,
            ShipType = c.ShipType,
            NavStatus = c.NavigationalStatus,
            // BarentsWatch's combined model carries no country/flag field; leave it null (unlike the
            // AIS-catcher feed, which derives a 2-letter flag from country_code).
            Flag = null,
            Seen = c.Msgtime is { } t ? Math.Max(0, (now - t).TotalSeconds) : null,
            Src = "barentswatch",
        };
    }

    private static VesselMetadata ToMetadata(BwCombined c) => new()
    {
        Mmsi = c.Mmsi.ToString(CultureInfo.InvariantCulture),
        Flag = null,
        CallSign = Blank(c.CallSign),
        Imo = c.ImoNumber is > 0 ? c.ImoNumber : null,
        Destination = Blank(c.Destination),
        Eta = Blank(c.Eta),
        // BarentsWatch reports draught in the raw AIS 1/10-metre encoding (e.g. 57 ⇒ 5.7 m); the
        // AIS-catcher feed already gives metres, so normalise BW to metres too.
        Draught = c.Draught is { } d and > 0 ? d / 10.0 : null,
        // The combined model has a numeric shipType only, no human-readable text.
        ShipTypeText = null,
        DimBow = c.DimensionA,
        DimStern = c.DimensionB,
        DimPort = c.DimensionC,
        DimStarboard = c.DimensionD,
        Source = "barentswatch",
    };

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    private readonly record struct SnapshotCache(DateTimeOffset FetchedAt, IReadOnlyList<VesselDto> Vessels);

    private sealed record OAuthTokenDto(
        [property: JsonPropertyName("access_token")] string? AccessToken,
        [property: JsonPropertyName("expires_in")] int ExpiresIn);

    /// <summary>Single-MMSI POST filter body for <c>/v1/latest/combined</c>.</summary>
    private sealed record BwFilter([property: JsonPropertyName("mmsi")] long Mmsi);

    /// <summary>
    ///     The BarentsWatch "combined" model (modelType=Full, modelFormat=Json) — merged latest
    ///     position + static/voyage for one target. Fields match the Live AIS OpenAPI verbatim.
    /// </summary>
    private sealed record BwCombined(
        [property: JsonPropertyName("mmsi")] long Mmsi,
        [property: JsonPropertyName("name")] string? Name,
        [property: JsonPropertyName("shipType")] int? ShipType,
        [property: JsonPropertyName("latitude")] double? Latitude,
        [property: JsonPropertyName("longitude")] double? Longitude,
        [property: JsonPropertyName("speedOverGround")] double? SpeedOverGround,
        [property: JsonPropertyName("courseOverGround")] double? CourseOverGround,
        [property: JsonPropertyName("trueHeading")] int? TrueHeading,
        [property: JsonPropertyName("navigationalStatus")] int? NavigationalStatus,
        [property: JsonPropertyName("msgtime")] DateTimeOffset? Msgtime,
        [property: JsonPropertyName("callSign")] string? CallSign,
        [property: JsonPropertyName("destination")] string? Destination,
        [property: JsonPropertyName("eta")] string? Eta,
        [property: JsonPropertyName("imoNumber")] long? ImoNumber,
        [property: JsonPropertyName("draught")] int? Draught,
        [property: JsonPropertyName("dimensionA")] int? DimensionA,
        [property: JsonPropertyName("dimensionB")] int? DimensionB,
        [property: JsonPropertyName("dimensionC")] int? DimensionC,
        [property: JsonPropertyName("dimensionD")] int? DimensionD);
}
