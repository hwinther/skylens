using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using Skylens.Api.Options;

namespace Skylens.Api.Enrichment;

/// <summary>
///     BarentsWatch FiskInfo ("extended") API client — a SECOND BarentsWatch OAuth2 client-credentials
///     client (separate credentials + scope from <see cref="BarentsWatchClient" />), serving the
///     "fishing mode" data: fishing-regulation zone polygons, lost/ghost fishing gear points, and NOR/NIS
///     ship-register enrichment. It mirrors <see cref="BarentsWatchClient" /> exactly — an OAuth token
///     cached until shortly before expiry behind a <see cref="SemaphoreSlim" /> gate, an
///     <see cref="EnrichmentCache" /> single-flight snapshot per dataset with a TTL, a keyed
///     <see cref="UpstreamBudget" /> that fails closed, and a <see cref="Configured" /> gate — but is
///     registered as a PLAIN SINGLETON over a NAMED <see cref="IHttpClientFactory" /> client
///     (<c>"fiskinfo"</c>), NOT a typed client, so its cached token + budget state survives.
///     <para>
///         Every method fails closed with a user-visible <see cref="LastReason" /> (never throws): an
///         unconfigured client yields an empty result, a budget/token/upstream failure yields
///         null/empty + a reason. Partial success is kept — if one zone dataset fails the others still
///         return.
///     </para>
/// </summary>
public sealed class FiskInfoClient
{
    /// <summary>Regulation zones change rarely, so the combined set caches for 12 h.</summary>
    private static readonly TimeSpan ZonesTtl = TimeSpan.FromHours(12);

    /// <summary>Lost-gear reports trickle in through the day, so refresh every 3 h.</summary>
    private static readonly TimeSpan LostGearTtl = TimeSpan.FromHours(3);

    /// <summary>Ship-register entries are near-static, so per-MMSI lookups cache for 7 days.</summary>
    private static readonly TimeSpan ShipRegisterTtl = TimeSpan.FromDays(7);

    private const string ZonesCacheKey = "fiskinfo:zones";
    private const string LostGearCacheKey = "fiskinfo:lostgear";

    private readonly IHttpClientFactory _httpFactory;
    private readonly FiskInfoOptions _options;
    private readonly EnrichmentCache _cache;
    private readonly UpstreamBudget _budget;
    private readonly TimeProvider _time;
    private readonly ILogger<FiskInfoClient> _logger;

    private readonly SemaphoreSlim _tokenGate = new(1, 1);

    private string? _token;
    private DateTimeOffset _tokenExpiry;

    public FiskInfoClient(
        IHttpClientFactory httpFactory,
        IOptions<FiskInfoOptions> options,
        EnrichmentCache cache,
        [FromKeyedServices("fiskinfo")] UpstreamBudget budget,
        TimeProvider time,
        ILogger<FiskInfoClient> logger)
    {
        _httpFactory = httpFactory;
        _options = options.Value;
        _cache = cache;
        _budget = budget;
        _time = time;
        _logger = logger;
    }

    public bool Configured => _options.Configured;

    public UpstreamBudget Budget => _budget;

    /// <summary>Last fail-closed reason surfaced to callers; null after a clean fetch.</summary>
    public string? LastReason { get; private set; }

    /// <summary>
    ///     The combined fishing-regulation zone set (coastal cod + forbidden + zero), cached 12 h behind a
    ///     single-flight gate. Each of the three datasets costs one budget unit on a miss; a dataset that
    ///     fails is dropped but the others are kept (partial success). Returns null when unconfigured or
    ///     when NOTHING could be fetched (token/budget/upstream all failed) — never throws.
    /// </summary>
    public async Task<FishingZones?> GetZonesAsync(CancellationToken ct)
    {
        if (!Configured)
        {
            LastReason = "fiskinfo-unconfigured";
            return null;
        }

        return await _cache.GetOrCreateAsync(ZonesCacheKey, ZonesTtl, FetchZonesAsync, ct);
    }

    /// <summary>
    ///     Lost/ghost fishing gear still in the water (anonymized for regular users), cached 3 h behind a
    ///     single-flight gate; one budget unit per miss. Returns null when unconfigured or when the fetch
    ///     failed (an empty-but-successful fetch caches an empty list). Never throws.
    /// </summary>
    public async Task<IReadOnlyList<LostGear>?> GetLostGearAsync(CancellationToken ct)
    {
        if (!Configured)
        {
            LastReason = "fiskinfo-unconfigured";
            return null;
        }

        return await _cache.GetOrCreateAsync<IReadOnlyList<LostGear>>(
            LostGearCacheKey, LostGearTtl, FetchLostGearAsync, ct);
    }

    /// <summary>
    ///     NOR/NIS ship-register basic info for one MMSI, cached 7 days per MMSI. Returns null when
    ///     unconfigured, over budget, the MMSI is non-numeric, or the vessel isn't in the register
    ///     (upstream 204/404). Never throws.
    /// </summary>
    public async Task<ShipRegister?> LookupShipRegisterAsync(string mmsi, CancellationToken ct)
    {
        if (!Configured)
            return null;
        if (!long.TryParse(mmsi, NumberStyles.Integer, CultureInfo.InvariantCulture, out var numeric))
            return null;

        return await _cache.GetOrCreateAsync(
            $"fiskinfo:shipreg:{numeric}",
            ShipRegisterTtl,
            innerCt => FetchShipRegisterAsync(numeric, innerCt),
            ct);
    }

    // -- Fetchers ------------------------------------------------------------------------------------

    private async Task<FishingZones?> FetchZonesAsync(CancellationToken ct)
    {
        var token = await GetTokenAsync(ct);
        if (token is null)
        {
            LastReason = "fiskinfo-unavailable";
            return null;
        }

        var http = _httpFactory.CreateClient("fiskinfo");

        // Sequential, one budget unit each; a dataset that fails is dropped (partial success is kept).
        var cod = await FetchCodZonesAsync(http, token, ct);
        var forbidden = await FetchForbiddenZonesAsync(http, token, ct);
        var zero = await FetchZeroZonesAsync(http, token, ct);

        // Nothing at all came back ⇒ null (uncached) so the endpoint surfaces a 503 + reason and a later
        // call can retry; any partial result is a cacheable success.
        if (cod is null && forbidden is null && zero is null)
            return null;

        var zones = new List<FishingZone>();
        if (cod is not null)
            zones.AddRange(cod);
        if (forbidden is not null)
            zones.AddRange(forbidden);
        if (zero is not null)
            zones.AddRange(zero);

        LastReason = null;
        return new FishingZones(_time.GetUtcNow(), zones);
    }

    /// <summary>
    ///     Coastal cod protection zones. There is no per-list JSON endpoint (only <c>/{areaId}</c>), so the
    ///     whole set is enumerated via the download endpoint, which returns a GeoJSON FeatureCollection.
    ///     Each feature's <c>geometry</c> passes through verbatim; the info is built from the start/end
    ///     point descriptions.
    /// </summary>
    private async Task<List<FishingZone>?> FetchCodZonesAsync(HttpClient http, string token, CancellationToken ct)
    {
        if (!TryConsumeBudget())
            return null;

        try
        {
            using var resp = await SendGetAsync(http, token,
                $"{_options.BaseUrl}/v1/geodata/download/coastalcodregulations?format=json", ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("FiskInfo coastalcodregulations returned {Status}", resp.StatusCode);
                LastReason = "fiskinfo-unavailable";
                return null;
            }

            var root = await resp.Content.ReadFromJsonAsync<JsonNode>(ct);
            if (root?["features"] is not JsonArray features)
                return [];

            var result = new List<FishingZone>(features.Count);
            foreach (var feature in features)
            {
                var geometry = feature?["geometry"];
                if (geometry is null)
                    continue;

                var props = feature?["properties"];
                var info = CombineDescriptions(
                    StringOrNull(props?["start_point_description"]),
                    StringOrNull(props?["end_point_description"]));
                result.Add(new FishingZone("cod", info, geometry.DeepClone()));
            }

            return result;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "FiskInfo coastalcodregulations fetch failed");
            LastReason = "fiskinfo-unavailable";
            return null;
        }
    }

    private async Task<List<FishingZone>?> FetchForbiddenZonesAsync(HttpClient http, string token, CancellationToken ct)
    {
        if (!TryConsumeBudget())
            return null;

        try
        {
            using var resp = await SendGetAsync(http, token,
                $"{_options.BaseUrl}/v1/geodata/forbiddenfishingzone", ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("FiskInfo forbiddenfishingzone returned {Status}", resp.StatusCode);
                LastReason = "fiskinfo-unavailable";
                return null;
            }

            var items = await resp.Content.ReadFromJsonAsync<List<ForbiddenZoneDto>>(ct);
            var result = new List<FishingZone>(items?.Count ?? 0);
            foreach (var z in items ?? [])
                if (z.Geometry is not null)
                    result.Add(new FishingZone("forbidden", Blank(z.Info), z.Geometry));

            return result;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "FiskInfo forbiddenfishingzone fetch failed");
            LastReason = "fiskinfo-unavailable";
            return null;
        }
    }

    private async Task<List<FishingZone>?> FetchZeroZonesAsync(HttpClient http, string token, CancellationToken ct)
    {
        if (!TryConsumeBudget())
            return null;

        try
        {
            using var resp = await SendGetAsync(http, token,
                $"{_options.BaseUrl}/v1/geodata/zerofishingarea", ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("FiskInfo zerofishingarea returned {Status}", resp.StatusCode);
                LastReason = "fiskinfo-unavailable";
                return null;
            }

            var items = await resp.Content.ReadFromJsonAsync<List<ZeroZoneDto>>(ct);
            var result = new List<FishingZone>(items?.Count ?? 0);
            foreach (var z in items ?? [])
                if (z.Geometry is not null)
                    result.Add(new FishingZone("zero", Blank(z.Name) ?? Blank(z.Info), z.Geometry));

            return result;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "FiskInfo zerofishingarea fetch failed");
            LastReason = "fiskinfo-unavailable";
            return null;
        }
    }

    private async Task<IReadOnlyList<LostGear>?> FetchLostGearAsync(CancellationToken ct)
    {
        var token = await GetTokenAsync(ct);
        if (token is null)
        {
            LastReason = "fiskinfo-unavailable";
            return null;
        }

        if (!TryConsumeBudget())
            return null;

        try
        {
            var http = _httpFactory.CreateClient("fiskinfo");
            // No `time` param → the current still-lost set.
            using var resp = await SendGetAsync(http, token,
                $"{_options.BaseUrl}/v1/lostfishingfacility/notremoved", ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("FiskInfo lostfishingfacility/notremoved returned {Status}", resp.StatusCode);
                LastReason = "fiskinfo-unavailable";
                return null;
            }

            var items = await resp.Content.ReadFromJsonAsync<List<LostFacilityDto>>(ct);
            var result = new List<LostGear>(items?.Count ?? 0);
            foreach (var g in items ?? [])
                result.Add(new LostGear(
                    Blank(g.ToolTypeCode), g.LostCount, g.LostTime, Blank(g.LostCause), Blank(g.Source), g.Geometry));

            LastReason = null;
            return result;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "FiskInfo lostfishingfacility fetch failed");
            LastReason = "fiskinfo-unavailable";
            return null;
        }
    }

    private async Task<ShipRegister?> FetchShipRegisterAsync(long mmsi, CancellationToken ct)
    {
        var token = await GetTokenAsync(ct);
        if (token is null)
            return null;

        if (!TryConsumeBudget())
            return null;

        try
        {
            var http = _httpFactory.CreateClient("fiskinfo");
            using var resp = await SendGetAsync(http, token,
                $"{_options.BaseUrl}/v2/shipregister/{mmsi}", ct);

            // v2 answers "not in register" with 204; treat a 404 the same way. Null ⇒ not cached.
            if (resp.StatusCode is HttpStatusCode.NoContent or HttpStatusCode.NotFound)
                return null;
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("FiskInfo shipregister (mmsi {Mmsi}) returned {Status}", mmsi, resp.StatusCode);
                LastReason = "fiskinfo-unavailable";
                return null;
            }

            var reg = await resp.Content.ReadFromJsonAsync<VesselRegistrationDto>(ct);
            return reg is null ? null : ToShipRegister(reg, mmsi);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "FiskInfo shipregister lookup failed for {Mmsi}", mmsi);
            LastReason = "fiskinfo-unavailable";
            return null;
        }
    }

    // -- Helpers -------------------------------------------------------------------------------------

    private bool TryConsumeBudget()
    {
        if (_budget.TryConsume())
            return true;

        _logger.LogWarning("FiskInfo daily budget exhausted ({Used}/{Limit})", _budget.Used, _budget.Limit);
        LastReason = "fiskinfo-budget-exhausted";
        return false;
    }

    private static async Task<HttpResponseMessage> SendGetAsync(
        HttpClient http, string token, string url, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return await http.SendAsync(req, ct);
    }

    private async Task<string?> GetTokenAsync(CancellationToken ct)
    {
        // Refresh a minute before expiry (mirrors BarentsWatchClient).
        if (_token is not null && _time.GetUtcNow() < _tokenExpiry - TimeSpan.FromMinutes(1))
            return _token;

        await _tokenGate.WaitAsync(ct);
        try
        {
            if (_token is not null && _time.GetUtcNow() < _tokenExpiry - TimeSpan.FromMinutes(1))
                return _token;

            var http = _httpFactory.CreateClient("fiskinfo");
            using var req = new HttpRequestMessage(HttpMethod.Post, _options.TokenEndpoint)
            {
                Content = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["grant_type"] = "client_credentials",
                    ["client_id"] = _options.ClientId!,
                    ["client_secret"] = _options.ClientSecret!,
                    ["scope"] = _options.Scope,
                }),
            };

            using var resp = await http.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("FiskInfo token endpoint returned {Status}", resp.StatusCode);
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

    private static ShipRegister ToShipRegister(VesselRegistrationDto reg, long mmsi) => new(
        Mmsi: (reg.Mmsi is > 0 ? reg.Mmsi.Value : mmsi).ToString(CultureInfo.InvariantCulture),
        Imo: reg.Imo is > 0 ? reg.Imo : null,
        CallSign: Blank(reg.CallSign),
        Name: Blank(reg.Name),
        RegNo: Blank(reg.Regno),
        VesselType: Blank(reg.Type?.DescriptionEn) ?? Blank(reg.Type?.DescriptionNo),
        Owner: Blank(reg.Owner?.Name),
        LengthOverall: reg.LengthOverall is > 0 ? reg.LengthOverall : reg.Length is > 0 ? reg.Length : null,
        GrossTonnage: reg.GrossTonnage is > 0 ? reg.GrossTonnage : null,
        Registered: reg.Registered);

    private static string? CombineDescriptions(string? start, string? end) =>
        (start, end) switch
        {
            (null, null) => null,
            (not null, null) => start,
            (null, not null) => end,
            _ => $"{start} → {end}",
        };

    private static string? StringOrNull(JsonNode? node) =>
        node?.GetValueKind() == System.Text.Json.JsonValueKind.String ? Blank(node.GetValue<string>()) : null;

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    private sealed record OAuthTokenDto(
        [property: JsonPropertyName("access_token")] string? AccessToken,
        [property: JsonPropertyName("expires_in")] int ExpiresIn);

    private sealed record ForbiddenZoneDto(
        [property: JsonPropertyName("geometry")] JsonNode? Geometry,
        [property: JsonPropertyName("objectId")] int? ObjectId,
        [property: JsonPropertyName("info")] string? Info);

    private sealed record ZeroZoneDto(
        [property: JsonPropertyName("geometry")] JsonNode? Geometry,
        [property: JsonPropertyName("objectId")] int? ObjectId,
        [property: JsonPropertyName("name")] string? Name,
        [property: JsonPropertyName("info")] string? Info,
        [property: JsonPropertyName("url")] string? Url);

    private sealed record LostFacilityDto(
        [property: JsonPropertyName("toolTypeCode")] string? ToolTypeCode,
        [property: JsonPropertyName("lostCount")] int? LostCount,
        [property: JsonPropertyName("lostTime")] DateTimeOffset? LostTime,
        [property: JsonPropertyName("lostCause")] string? LostCause,
        [property: JsonPropertyName("source")] string? Source,
        [property: JsonPropertyName("geometry")] JsonNode? Geometry);

    private sealed record VesselRegistrationDto(
        [property: JsonPropertyName("mmsi")] long? Mmsi,
        [property: JsonPropertyName("imo")] long? Imo,
        [property: JsonPropertyName("callSign")] string? CallSign,
        [property: JsonPropertyName("regno")] string? Regno,
        [property: JsonPropertyName("name")] string? Name,
        [property: JsonPropertyName("lengthOverall")] double? LengthOverall,
        [property: JsonPropertyName("length")] double? Length,
        [property: JsonPropertyName("grossTonnage")] double? GrossTonnage,
        [property: JsonPropertyName("registered")] bool Registered,
        [property: JsonPropertyName("type")] VesselTypeDto? Type,
        [property: JsonPropertyName("owner")] OwnerDto? Owner);

    private sealed record VesselTypeDto(
        [property: JsonPropertyName("id")] string? Id,
        [property: JsonPropertyName("descriptionEn")] string? DescriptionEn,
        [property: JsonPropertyName("descriptionNo")] string? DescriptionNo);

    private sealed record OwnerDto(
        [property: JsonPropertyName("orgNumber")] int? OrgNumber,
        [property: JsonPropertyName("name")] string? Name);
}
