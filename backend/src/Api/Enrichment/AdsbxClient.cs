using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using Skylens.Api.Broadcast;
using Skylens.Api.Options;
using Skylens.Api.State;

namespace Skylens.Api.Enrichment;

/// <summary>
///     ADSBx (RapidAPI) point-radius away-mode source. Requests are bucketed into 0.5° grid cells and
///     each cell is fetched at most once per 10 s (shared across all subscribers in the cell); results
///     are cached for that interval and tagged <c>src:"adsbx"</c>. A monthly <see cref="UpstreamBudget" />
///     fails closed with a user-visible reason. Also serves the REST <c>/api/area</c> endpoint.
/// </summary>
public sealed class AdsbxClient : IAwayModeSource
{
    private const double CellSizeDeg = 0.5;
    private static readonly TimeSpan CellInterval = TimeSpan.FromSeconds(10);

    private readonly HttpClient _http;
    private readonly AdsbxOptions _options;
    private readonly UpstreamBudget _budget;
    private readonly TimeProvider _time;
    private readonly ILogger<AdsbxClient> _logger;

    private readonly ConcurrentDictionary<(int, int), CellCache> _cells = new();
    private readonly ConcurrentDictionary<(int, int), SemaphoreSlim> _cellGates = new();

    public AdsbxClient(
        HttpClient http,
        IOptions<AdsbxOptions> options,
        [FromKeyedServices("adsbx")] UpstreamBudget budget,
        TimeProvider time,
        ILogger<AdsbxClient> logger)
    {
        _http = http;
        _options = options.Value;
        _budget = budget;
        _time = time;
        _logger = logger;
    }

    public bool Configured => !string.IsNullOrEmpty(_options.RapidApiKey);

    public UpstreamBudget Budget => _budget;

    public async Task<AwayModeResult> GetAsync(double lat, double lon, double radiusKm, CancellationToken ct)
    {
        if (!Configured)
            return new AwayModeResult([], "away-mode-unconfigured");

        var cell = CellOf(lat, lon);
        var now = _time.GetUtcNow();

        // Serve a fresh cached cell without touching the budget.
        if (_cells.TryGetValue(cell, out var cached) && now - cached.FetchedAt < CellInterval)
            return FilterToRadius(cached.Aircraft, lat, lon, radiusKm);

        var gate = _cellGates.GetOrAdd(cell, static _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            now = _time.GetUtcNow();
            if (_cells.TryGetValue(cell, out cached) && now - cached.FetchedAt < CellInterval)
                return FilterToRadius(cached.Aircraft, lat, lon, radiusKm);

            if (!_budget.TryConsume())
            {
                _logger.LogWarning("ADSBx monthly budget exhausted ({Used}/{Limit})", _budget.Used, _budget.Limit);
                return new AwayModeResult([], "adsbx-budget-exhausted");
            }

            var aircraft = await FetchAsync(lat, lon, radiusKm, ct);
            _cells[cell] = new CellCache(_time.GetUtcNow(), aircraft);
            return FilterToRadius(aircraft, lat, lon, radiusKm);
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<IReadOnlyList<AircraftDto>> FetchAsync(double lat, double lon, double radiusKm, CancellationToken ct)
    {
        // RapidAPI ADSBx point-radius uses nautical miles; cap at the API's 250 nm ceiling.
        var nm = Math.Min(250, radiusKm / 1.852);
        var url = string.Format(
            CultureInfo.InvariantCulture,
            "https://{0}/v2/lat/{1:0.####}/lon/{2:0.####}/dist/{3:0.##}/",
            _options.RapidApiHost, lat, lon, nm);

        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.TryAddWithoutValidation("X-RapidAPI-Key", _options.RapidApiKey);
        req.Headers.TryAddWithoutValidation("X-RapidAPI-Host", _options.RapidApiHost);

        using var resp = await _http.SendAsync(req, ct);
        resp.EnsureSuccessStatusCode();

        var payload = await resp.Content.ReadFromJsonAsync<AdsbxResponse>(ct);
        if (payload?.Aircraft is null)
            return [];

        var result = new List<AircraftDto>(payload.Aircraft.Count);
        foreach (var a in payload.Aircraft)
        {
            if (a.Hex is null || a.Lat is null || a.Lon is null)
                continue;
            var alt = ParseAlt(a.AltBaro);
            result.Add(new AircraftDto
            {
                Hex = a.Hex.ToLowerInvariant(),
                Flight = a.Flight?.Trim(),
                Fl = alt is { } altFt ? (int)Math.Round(altFt / 100.0) : null,
                Lat = a.Lat,
                Lon = a.Lon,
                Alt = alt,
                Gs = a.GroundSpeed,
                Trk = a.Track,
                Vr = a.BaroRate,
                Seen = a.Seen,
                Cat = a.Category,
                Src = "adsbx",
            });
        }

        return result;
    }

    private static AwayModeResult FilterToRadius(IReadOnlyList<AircraftDto> aircraft, double lat, double lon, double radiusKm)
    {
        var result = new List<AircraftDto>(aircraft.Count);
        foreach (var a in aircraft)
        {
            if (a.Lat is null || a.Lon is null)
                continue;
            if (Geo.DistanceKm(lat, lon, a.Lat.Value, a.Lon.Value) <= radiusKm)
                result.Add(a);
        }

        return new AwayModeResult(result, null);
    }

    internal static (int, int) CellOf(double lat, double lon) =>
        ((int)Math.Floor(lat / CellSizeDeg), (int)Math.Floor(lon / CellSizeDeg));

    private static int? ParseAlt(object? altBaro) => altBaro switch
    {
        null => null,
        System.Text.Json.JsonElement el when el.ValueKind == System.Text.Json.JsonValueKind.Number &&
                                              el.TryGetInt32(out var i) => i,
        _ => null, // "ground" string → null
    };

    private readonly record struct CellCache(DateTimeOffset FetchedAt, IReadOnlyList<AircraftDto> Aircraft);

    private sealed record AdsbxResponse([property: JsonPropertyName("ac")] List<AdsbxAircraft>? Aircraft);

    private sealed record AdsbxAircraft(
        [property: JsonPropertyName("hex")] string? Hex,
        [property: JsonPropertyName("flight")] string? Flight,
        [property: JsonPropertyName("lat")] double? Lat,
        [property: JsonPropertyName("lon")] double? Lon,
        [property: JsonPropertyName("alt_baro")] object? AltBaro,
        [property: JsonPropertyName("gs")] double? GroundSpeed,
        [property: JsonPropertyName("track")] double? Track,
        [property: JsonPropertyName("baro_rate")] int? BaroRate,
        [property: JsonPropertyName("category")] string? Category,
        [property: JsonPropertyName("seen")] double? Seen);
}
