using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Skylens.Api.Broadcast;
using Skylens.Api.State;

namespace Skylens.Api.Enrichment;

/// <summary>
///     Shared away-mode plumbing for point-radius providers that answer in the readsb/tar1090 JSON shape
///     (<c>{"ac":[{hex,flight,lat,lon,alt_baro,…}]}</c>) — ADSBx via RapidAPI and adsb.lol. Requests are
///     bucketed into 0.5° grid cells; each cell is fetched at most once per 10 s, shared across every
///     viewer in it, behind a per-cell single-flight gate and an <see cref="UpstreamBudget" /> that fails
///     closed. The provider is always asked for the cell CENTRE with the radius padded to cover the whole
///     cell, so it never sees a viewer's exact position and one fetch serves every viewer in the cell.
///     Failures are cached for the same interval (with a reason), so a broken upstream is not retried by
///     the 1 Hz broadcast loop on every tick.
/// </summary>
public abstract class ReadsbPointSource : IAwayModeSource
{
    internal const double CellSizeDeg = 0.5;

    /// <summary>Point-radius ceiling shared by both providers' APIs.</summary>
    internal const double MaxRadiusNm = 250;

    internal static readonly TimeSpan CellInterval = TimeSpan.FromSeconds(10);

    private readonly HttpClient _http;
    private readonly UpstreamBudget _budget;
    private readonly TimeProvider _time;
    private readonly ILogger _logger;
    private readonly ConcurrentDictionary<(int, int), CellCache> _cells = new();
    private readonly ConcurrentDictionary<(int, int), SemaphoreSlim> _cellGates = new();

    protected ReadsbPointSource(HttpClient http, UpstreamBudget budget, TimeProvider time, ILogger logger)
    {
        _http = http;
        _budget = budget;
        _time = time;
        _logger = logger;
    }

    /// <summary>Tag written to each aircraft's <c>src</c>, also the prefix of every status reason.</summary>
    protected abstract string SourceTag { get; }

    public abstract bool Configured { get; }

    public UpstreamBudget Budget => _budget;

    /// <summary>Build the provider request for a point-radius query (radius already capped).</summary>
    protected abstract HttpRequestMessage BuildRequest(double lat, double lon, double radiusNm);

    public async Task<AwayModeResult> GetAsync(double lat, double lon, double radiusKm, CancellationToken ct)
    {
        if (!Configured)
            return new AwayModeResult([], $"{SourceTag}-unconfigured");

        var cell = CellOf(lat, lon);
        var (centerLat, centerLon) = CellCenter(cell);
        // Padding covers the farthest viewer position inside the cell, so the cached centre query
        // still contains every aircraft within radiusKm of that viewer.
        var neededKm = radiusKm + CellHalfDiagonalKm(cell);

        if (TryServeCached(cell, neededKm, lat, lon, radiusKm, out var hit))
            return hit;

        var gate = _cellGates.GetOrAdd(cell, static _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            if (TryServeCached(cell, neededKm, lat, lon, radiusKm, out hit))
                return hit;

            if (!_budget.TryConsume())
            {
                _logger.LogWarning("{Source} budget exhausted ({Used}/{Limit})", SourceTag, _budget.Used, _budget.Limit);
                return new AwayModeResult([], $"{SourceTag}-budget-exhausted");
            }

            var radiusNm = Math.Min(MaxRadiusNm, neededKm / 1.852);
            try
            {
                var aircraft = await FetchAsync(centerLat, centerLon, radiusNm, ct);
                _cells[cell] = new CellCache(_time.GetUtcNow(), radiusNm * 1.852, aircraft, null);
                return FilterToRadius(aircraft, lat, lon, radiusKm);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                _logger.LogWarning(ex, "{Source} away-mode fetch failed for cell {Cell}", SourceTag, cell);
                var reason = $"{SourceTag}-upstream-error";
                _cells[cell] = new CellCache(_time.GetUtcNow(), radiusNm * 1.852, [], reason);
                return new AwayModeResult([], reason);
            }
        }
        finally
        {
            gate.Release();
        }
    }

    private bool TryServeCached(
        (int, int) cell, double neededKm, double lat, double lon, double radiusKm, out AwayModeResult result)
    {
        result = AwayModeResult.Empty;
        if (!_cells.TryGetValue(cell, out var cached) || _time.GetUtcNow() - cached.FetchedAt >= CellInterval)
            return false;
        // A failure is served for the whole interval whatever the radius: that's what stops the retry storm.
        if (cached.FailureReason is not null)
        {
            result = new AwayModeResult([], cached.FailureReason);
            return true;
        }

        // A smaller cached query can't answer a wider viewer; refetch (the cap keeps this bounded).
        if (cached.RadiusKm + 0.001 < Math.Min(neededKm, MaxRadiusNm * 1.852))
            return false;
        result = FilterToRadius(cached.Aircraft, lat, lon, radiusKm);
        return true;
    }

    private async Task<IReadOnlyList<AircraftDto>> FetchAsync(double lat, double lon, double radiusNm, CancellationToken ct)
    {
        using var req = BuildRequest(lat, lon, radiusNm);
        using var resp = await _http.SendAsync(req, ct);
        resp.EnsureSuccessStatusCode();
        var payload = await resp.Content.ReadFromJsonAsync<ReadsbResponse>(ct);
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
                Src = SourceTag,
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

    internal static (double Lat, double Lon) CellCenter((int, int) cell) =>
        ((cell.Item1 + 0.5) * CellSizeDeg, (cell.Item2 + 0.5) * CellSizeDeg);

    /// <summary>
    ///     Centre-to-corner distance. The equatorward and poleward corners differ (meridians converge
    ///     toward the pole), so take the larger of the two.
    /// </summary>
    internal static double CellHalfDiagonalKm((int, int) cell)
    {
        var (lat, lon) = CellCenter(cell);
        var half = CellSizeDeg / 2;
        return Math.Max(
            Geo.DistanceKm(lat, lon, lat - half, lon + half),
            Geo.DistanceKm(lat, lon, lat + half, lon + half));
    }

    private static int? ParseAlt(object? altBaro) => altBaro switch
    {
        null => null,
        System.Text.Json.JsonElement el when el.ValueKind == System.Text.Json.JsonValueKind.Number &&
                                              el.TryGetInt32(out var i) => i,
        _ => null, // "ground" string → null
    };

    private readonly record struct CellCache(
        DateTimeOffset FetchedAt, double RadiusKm, IReadOnlyList<AircraftDto> Aircraft, string? FailureReason);

    private sealed record ReadsbResponse([property: JsonPropertyName("ac")] List<ReadsbAircraft>? Aircraft);

    private sealed record ReadsbAircraft(
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
