using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using Skylens.Api.Options;

namespace Skylens.Api.Enrichment;

/// <summary>
///     Lazily pulls the SatNOGS transmitter DB once and holds it as a process-wide dictionary keyed by
///     NORAD id, refreshed at most once per <see cref="Ttl" />. The bulk endpoint
///     (<c>GET /api/transmitters/?format=json</c>) returns effectively the whole DB (~5000 rows) in a
///     single JSON array, so the paging loop normally makes exactly one request; it stays defensive
///     about a future DRF-paginated envelope. One <see cref="UpstreamBudget" /> unit is spent per page
///     request. Unlike CelesTrak this source is stale-ok forever: a failed refresh silently keeps
///     whatever was already loaded (transmitter data barely changes).
///     <para>
///         <see cref="FreqSummary(int)" /> renders a satellite's best active downlink as a short label
///         like <c>"145.800 MHz FM"</c> for the satellite list UI. Development-gated
///         <see cref="SatellitesOptions.TransmittersFile" /> replaces the network with an on-disk fixture.
///     </para>
/// </summary>
public sealed class SatNogsClient
{
    /// <summary>Transmitter frequencies change rarely, so the whole DB caches for a day.</summary>
    private static readonly TimeSpan Ttl = TimeSpan.FromHours(24);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private static readonly IReadOnlyDictionary<int, IReadOnlyList<SatelliteTransmitterDto>> Empty =
        new Dictionary<int, IReadOnlyList<SatelliteTransmitterDto>>();

    private readonly IHttpClientFactory _httpFactory;
    private readonly SatellitesOptions _options;
    private readonly UpstreamBudget _budget;
    private readonly IHostEnvironment _env;
    private readonly TimeProvider _time;
    private readonly ILogger<SatNogsClient> _logger;

    private readonly SemaphoreSlim _gate = new(1, 1);

    private volatile IReadOnlyDictionary<int, IReadOnlyList<SatelliteTransmitterDto>>? _byNorad;
    private DateTimeOffset _fetchedAt;

    public SatNogsClient(
        IHttpClientFactory httpFactory,
        IOptions<SatellitesOptions> options,
        [FromKeyedServices("satnogs")] UpstreamBudget budget,
        IHostEnvironment env,
        TimeProvider time,
        ILogger<SatNogsClient> logger)
    {
        _httpFactory = httpFactory;
        _options = options.Value;
        _budget = budget;
        _env = env;
        _time = time;
        _logger = logger;
    }

    /// <summary>Last fail-closed reason surfaced to callers/healthz; null after a clean load.</summary>
    public string? LastReason { get; private set; }

    /// <summary>When the transmitter DB was last loaded (null before the first successful load).</summary>
    public DateTimeOffset? FetchedAt => _byNorad is null ? null : _fetchedAt;

    /// <summary>Number of satellites with transmitters currently loaded (0 before the first load).</summary>
    public int Count => _byNorad?.Count ?? 0;

    /// <summary>
    ///     The transmitter DB keyed by NORAD id, loaded lazily on first call and cached for
    ///     <see cref="Ttl" />. A failed refresh keeps the previous (stale) map; before any successful
    ///     load a failure yields an empty map.
    /// </summary>
    public async Task<IReadOnlyDictionary<int, IReadOnlyList<SatelliteTransmitterDto>>> GetAsync(CancellationToken ct)
    {
        var map = _byNorad;
        var now = _time.GetUtcNow();
        if (map is not null && now - _fetchedAt < Ttl)
            return map;

        await _gate.WaitAsync(ct);
        try
        {
            now = _time.GetUtcNow();
            if (_byNorad is { } current && now - _fetchedAt < Ttl)
                return current;

            // Development-only fixture short-circuits the network entirely.
            if (TryLoadFixture(out var fixtureMap))
            {
                _byNorad = fixtureMap;
                _fetchedAt = _time.GetUtcNow();
                LastReason = null;
                return fixtureMap;
            }

            var fetched = await FetchAllAsync(ct);
            if (fetched is not null)
            {
                _byNorad = fetched;
                _fetchedAt = _time.GetUtcNow();
                LastReason = null;
                return fetched;
            }

            // Failed refresh — stale-ok forever. Serve whatever we had (empty before the first load).
            return _byNorad ?? Empty;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    ///     Best active-downlink summary for a satellite, or null if it has no loaded transmitters / no
    ///     active downlink. Reads the already-loaded map (call <see cref="GetAsync" /> once first).
    /// </summary>
    public string? FreqSummary(int noradId) =>
        _byNorad is { } map && map.TryGetValue(noradId, out var transmitters)
            ? FreqSummary(transmitters)
            : null;

    /// <summary>
    ///     Formats the best ACTIVE (<c>status == "active" &amp;&amp; alive</c>) transmitter that has a
    ///     downlink as <c>"&lt;MHz to 3 dp&gt; MHz &lt;mode&gt;"</c> (e.g. downlink 145800000 + FM ⇒
    ///     <c>"145.800 MHz FM"</c>; mode omitted when absent). Prefers a Transmitter/Transceiver over a
    ///     Transponder; otherwise keeps the first active downlink seen. Returns null when none qualify.
    /// </summary>
    internal static string? FreqSummary(IReadOnlyList<SatelliteTransmitterDto> transmitters)
    {
        SatelliteTransmitterDto? best = null;
        foreach (var t in transmitters)
        {
            if (!t.Alive || !string.Equals(t.Status, "active", StringComparison.OrdinalIgnoreCase))
                continue;
            if (t.DownlinkLowHz is not > 0)
                continue;

            if (best is null)
            {
                best = t;
                continue;
            }

            // Upgrade a first-seen Transponder to a proper Transmitter/Transceiver if one turns up.
            if (IsPreferredType(t.Type) && !IsPreferredType(best.Type))
                best = t;
        }

        if (best?.DownlinkLowHz is not { } hz)
            return null;

        var mhz = (hz / 1_000_000.0).ToString("F3", CultureInfo.InvariantCulture);
        return string.IsNullOrWhiteSpace(best.Mode) ? $"{mhz} MHz" : $"{mhz} MHz {best.Mode}";
    }

    private static bool IsPreferredType(string? type) =>
        string.Equals(type, "Transmitter", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(type, "Transceiver", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    ///     Pulls the transmitter DB. Bare-array responses are the whole DB in one page (the common case);
    ///     a DRF <c>{ results, next }</c> envelope is followed defensively while a next page is indicated.
    ///     One budget unit per page; any non-200/parse failure/over-budget stops paging and keeps
    ///     whatever pages were already gathered (stale-ok). Returns null only when nothing was loaded.
    /// </summary>
    private async Task<IReadOnlyDictionary<int, IReadOnlyList<SatelliteTransmitterDto>>?> FetchAllAsync(
        CancellationToken ct)
    {
        var http = _httpFactory.CreateClient("satnogs");
        var all = new List<SatNogsTransmitter>();
        var page = 1;

        while (true)
        {
            if (!_budget.TryConsume())
            {
                _logger.LogWarning("SatNOGS daily budget exhausted ({Used}/{Limit})", _budget.Used, _budget.Limit);
                LastReason = "satnogs-budget-exhausted";
                break;
            }

            (List<SatNogsTransmitter>? Items, bool HasNext)? result;
            try
            {
                var url = $"{_options.SatNogsBaseUrl}/api/transmitters/?format=json&page={page}";
                using var resp = await http.GetAsync(url, ct);
                if (!resp.IsSuccessStatusCode)
                {
                    _logger.LogWarning("SatNOGS transmitters returned {Status}", resp.StatusCode);
                    LastReason = "satnogs-unavailable";
                    break;
                }

                var body = await resp.Content.ReadAsStringAsync(ct);
                result = ParsePage(body);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "SatNOGS transmitters fetch failed");
                LastReason = "satnogs-unavailable";
                break;
            }

            if (result is not { } page1)
            {
                LastReason = "satnogs-unavailable";
                break;
            }

            if (page1.Items is { Count: > 0 } items)
                all.AddRange(items);

            if (!page1.HasNext || page1.Items is not { Count: > 0 })
                break;

            page++;
        }

        // Nothing gathered ⇒ signal a hard miss (null) so GetAsync serves whatever stale map it holds
        // rather than mistaking this for a fresh, empty success.
        if (all.Count == 0)
            return null;

        return BuildMap(all);
    }

    /// <summary>
    ///     Parses one response body into (items, hasNext). A bare JSON array is the bulk pull (no next
    ///     page). A <c>{ results: [...], next: "..." }</c> object is DRF pagination. Returns null when
    ///     the body is neither (e.g. a plain-text error), which the caller treats as a failure.
    /// </summary>
    private static (List<SatNogsTransmitter>? Items, bool HasNext)? ParsePage(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;

            if (root.ValueKind == JsonValueKind.Array)
                return (root.Deserialize<List<SatNogsTransmitter>>(JsonOptions), false);

            if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("results", out var results) &&
                results.ValueKind == JsonValueKind.Array)
            {
                var hasNext = root.TryGetProperty("next", out var next) &&
                              next.ValueKind == JsonValueKind.String &&
                              !string.IsNullOrEmpty(next.GetString());
                return (results.Deserialize<List<SatNogsTransmitter>>(JsonOptions), hasNext);
            }

            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static IReadOnlyDictionary<int, IReadOnlyList<SatelliteTransmitterDto>> BuildMap(
        IEnumerable<SatNogsTransmitter> raw)
    {
        var grouped = new Dictionary<int, List<SatelliteTransmitterDto>>();
        foreach (var t in raw)
        {
            // norad_cat_id is nullable in SatNOGS (unmatched objects); those rows are unusable here.
            if (t.NoradCatId is not { } norad)
                continue;

            if (!grouped.TryGetValue(norad, out var list))
                grouped[norad] = list = [];
            list.Add(new SatelliteTransmitterDto(
                t.Description, t.Type, t.DownlinkLow, t.DownlinkHigh, t.UplinkLow, t.UplinkHigh,
                t.Mode, t.Baud, t.Status, t.Alive));
        }

        var map = new Dictionary<int, IReadOnlyList<SatelliteTransmitterDto>>(grouped.Count);
        foreach (var (norad, list) in grouped)
            map[norad] = list;
        return map;
    }

    /// <summary>
    ///     Dev-only fixture load. Honored only in Development with
    ///     <see cref="SatellitesOptions.TransmittersFile" /> set and present; outside Development it logs
    ///     a warning and is ignored. The file is a raw SatNOGS-shaped JSON array of transmitters.
    /// </summary>
    private bool TryLoadFixture(
        [NotNullWhen(true)] out IReadOnlyDictionary<int, IReadOnlyList<SatelliteTransmitterDto>>? map)
    {
        map = null;
        var path = _options.TransmittersFile;
        if (string.IsNullOrWhiteSpace(path))
            return false;

        if (!_env.IsDevelopment())
        {
            _logger.LogWarning(
                "Satellites:TransmittersFile is set but ignored outside Development (environment {Env})",
                _env.EnvironmentName);
            return false;
        }

        var resolved = ResolvePath(path);
        if (!File.Exists(resolved))
        {
            _logger.LogWarning("Satellites:TransmittersFile {Path} not found; falling back to SatNOGS", resolved);
            return false;
        }

        try
        {
            using var stream = File.OpenRead(resolved);
            var raw = JsonSerializer.Deserialize<List<SatNogsTransmitter>>(stream, JsonOptions);
            if (raw is null)
                return false;

            map = BuildMap(raw);
            _logger.LogInformation(
                "Loaded transmitters for {Count} satellites from fixture {Path}", map.Count, resolved);
            return true;
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            _logger.LogWarning(ex, "Failed to load transmitters fixture {Path}; falling back to SatNOGS", resolved);
            return false;
        }
    }

    private string ResolvePath(string path) =>
        Path.IsPathRooted(path) ? path : Path.GetFullPath(Path.Combine(_env.ContentRootPath, path));

    /// <summary>The SatNOGS transmitter shape we consume (a superset of fields is ignored).</summary>
    private sealed record SatNogsTransmitter(
        [property: JsonPropertyName("description")] string? Description,
        [property: JsonPropertyName("type")] string? Type,
        [property: JsonPropertyName("downlink_low")] long? DownlinkLow,
        [property: JsonPropertyName("downlink_high")] long? DownlinkHigh,
        [property: JsonPropertyName("uplink_low")] long? UplinkLow,
        [property: JsonPropertyName("uplink_high")] long? UplinkHigh,
        [property: JsonPropertyName("mode")] string? Mode,
        [property: JsonPropertyName("baud")] double? Baud,
        [property: JsonPropertyName("norad_cat_id")] int? NoradCatId,
        [property: JsonPropertyName("status")] string? Status,
        [property: JsonPropertyName("alive")] bool Alive);
}
