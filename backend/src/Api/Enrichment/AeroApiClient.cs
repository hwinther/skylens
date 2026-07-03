using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using Skylens.Api.Options;

namespace Skylens.Api.Enrichment;

/// <summary>
///     FlightAware AeroAPI route lookups by callsign (on tap only). Cached 6 h with per-key
///     single-flight; a daily <see cref="UpstreamBudget" /> fails closed. Returns null when the budget
///     is exhausted or the key is unconfigured — the endpoint maps that to a 503-with-reason.
/// </summary>
public sealed class AeroApiClient
{
    private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(6);

    private readonly HttpClient _http;
    private readonly AeroApiOptions _options;
    private readonly EnrichmentCache _cache;
    private readonly UpstreamBudget _budget;
    private readonly ILogger<AeroApiClient> _logger;

    public AeroApiClient(
        HttpClient http,
        IOptions<AeroApiOptions> options,
        EnrichmentCache cache,
        [FromKeyedServices("aeroapi")] UpstreamBudget budget,
        ILogger<AeroApiClient> logger)
    {
        _http = http;
        _options = options.Value;
        _cache = cache;
        _budget = budget;
        _logger = logger;
    }

    public bool Configured => !string.IsNullOrEmpty(_options.ApiKey);

    public UpstreamBudget Budget => _budget;

    /// <summary>The last outcome of <see cref="GetRouteAsync" /> when it returned null (for the endpoint's reason).</summary>
    public string? LastReason { get; private set; }

    private static string RouteKey(string callsign) => $"aeroapi:route:{callsign.Trim().ToUpperInvariant()}";

    /// <summary>
    ///     Return an already-cached route without any upstream call or budget spend (null if not cached).
    ///     Lets the client auto-show routes on detail open without the on-tap-only budget rule applying.
    /// </summary>
    public FlightRoute? GetCachedRoute(string callsign) =>
        _cache.TryGet<FlightRoute>(RouteKey(callsign), out var route) ? route : null;

    public async Task<FlightRoute?> GetRouteAsync(string callsign, CancellationToken ct)
    {
        LastReason = null;
        var ident = callsign.Trim().ToUpperInvariant();
        if (ident.Length == 0)
        {
            LastReason = "no-callsign";
            return null;
        }

        if (!Configured)
        {
            LastReason = "aeroapi-unconfigured";
            return null;
        }

        // Cache hit path never touches the budget.
        var cached = await _cache.GetOrCreateAsync(
            RouteKey(ident),
            CacheTtl,
            async innerCt =>
            {
                if (!_budget.TryConsume())
                {
                    _logger.LogWarning("AeroAPI daily budget exhausted ({Used}/{Limit})", _budget.Used, _budget.Limit);
                    LastReason = "aeroapi-budget-exhausted";
                    return null;
                }

                return await FetchAsync(ident, innerCt);
            },
            ct);

        if (cached is null && LastReason is null)
            LastReason = "not-found";
        return cached;
    }

    private async Task<FlightRoute?> FetchAsync(string ident, CancellationToken ct)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, $"{_options.BaseUrl}/flights/{ident}");
            req.Headers.TryAddWithoutValidation("x-apikey", _options.ApiKey);

            using var resp = await _http.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("AeroAPI returned {Status} for {Ident}", resp.StatusCode, ident);
                return null;
            }

            var payload = await resp.Content.ReadFromJsonAsync<AeroApiFlightsDto>(ct);
            var flight = payload?.Flights?.FirstOrDefault();
            if (flight is null)
                return null;

            return new FlightRoute
            {
                Ident = ident,
                OriginIcao = flight.Origin?.Code,
                OriginName = flight.Origin?.Name,
                DestinationIcao = flight.Destination?.Code,
                DestinationName = flight.Destination?.Name,
                Source = "aeroapi",
            };
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "AeroAPI lookup failed for {Ident}", ident);
            return null;
        }
    }

    private sealed record AeroApiFlightsDto(
        [property: JsonPropertyName("flights")] List<AeroApiFlight>? Flights);

    private sealed record AeroApiFlight(
        [property: JsonPropertyName("origin")] AeroApiAirport? Origin,
        [property: JsonPropertyName("destination")] AeroApiAirport? Destination);

    private sealed record AeroApiAirport(
        [property: JsonPropertyName("code_icao")] string? Code,
        [property: JsonPropertyName("name")] string? Name);
}
