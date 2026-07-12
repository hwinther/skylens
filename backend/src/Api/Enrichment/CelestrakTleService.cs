using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Skylens.Api.Options;

namespace Skylens.Api.Enrichment;

/// <summary>
///     Fetches satellite orbital elements (OMM/GP JSON) from CelesTrak and holds them in a single
///     process-wide snapshot, refreshed at most once per <see cref="Ttl" />. Mirrors
///     <see cref="BarentsWatchClient" />'s shape — SemaphoreSlim single-flight, one
///     <see cref="UpstreamBudget" /> unit per upstream request, fail-closed reasons, injected
///     <see cref="TimeProvider" /> — but pulls a list of CelesTrak groups sequentially per cycle and
///     merges them (deduped by NORAD id with precedence stations &gt; amateur &gt; weather &gt; gnss).
///     <para>
///         CelesTrak-firewall safety invariant: an <b>invalid query returns HTTP 200 with a plain-text
///         error body</b> (e.g. <c>Invalid query: "GROUP=noaa..." (GROUP=noaa not found)</c>), so any
///         200 whose body does not parse as a JSON array is treated exactly like a non-200 — the whole
///         cycle aborts, the previous snapshot is kept, and an exponential backoff is armed. This stops
///         a bad config from hammering CelesTrak and getting the deployment IP firewalled.
///     </para>
///     <para>
///         Stale-while-revalidate: a fresh snapshot is served without touching the gate; a stale one is
///         served immediately while a single background refresh runs; cold start fetches synchronously
///         under the gate. Development-gated <see cref="SatellitesOptions.TleFile" /> replaces the
///         network with an on-disk fixture (never any HTTP).
///     </para>
/// </summary>
public sealed class CelestrakTleService
{
    /// <summary>Orbital elements drift slowly; a two-hour-old snapshot is still perfectly usable.</summary>
    private static readonly TimeSpan Ttl = TimeSpan.FromHours(2);

    /// <summary>First backoff after a failed cycle; doubles per consecutive failure up to the cap.</summary>
    private static readonly TimeSpan InitialBackoff = TimeSpan.FromMinutes(30);

    /// <summary>Backoff never grows past four hours.</summary>
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromHours(4);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly IHttpClientFactory _httpFactory;
    private readonly SatellitesOptions _options;
    private readonly UpstreamBudget _budget;
    private readonly IHostEnvironment _env;
    private readonly TimeProvider _time;
    private readonly ILogger<CelestrakTleService> _logger;

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly object _refreshLock = new();

    private volatile TleSnapshot? _snapshot;
    private DateTimeOffset _backoffUntil;
    private TimeSpan _backoff = InitialBackoff;
    private Task? _refreshTask;

    /// <summary>
    ///     Politeness spacing between sequential group requests (CelesTrak asks callers to pace out
    ///     bulk pulls). A real <see cref="Task.Delay(TimeSpan, CancellationToken)" /> deliberately
    ///     decoupled from <see cref="_time" /> so the injected clock only drives TTL/backoff logic;
    ///     tests set it to <see cref="TimeSpan.Zero" /> to keep the fetch loop instantaneous.
    /// </summary>
    internal TimeSpan RequestSpacing { get; set; } = TimeSpan.FromMilliseconds(250);

    public CelestrakTleService(
        IHttpClientFactory httpFactory,
        IOptions<SatellitesOptions> options,
        [FromKeyedServices("celestrak")] UpstreamBudget budget,
        IHostEnvironment env,
        TimeProvider time,
        ILogger<CelestrakTleService> logger)
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

    /// <summary>When the current snapshot was built (null before the first successful load).</summary>
    public DateTimeOffset? FetchedAt => _snapshot?.FetchedAt;

    /// <summary>Deduped satellite count in the current snapshot (0 before the first load).</summary>
    public int Count => _snapshot?.Records.Count ?? 0;

    /// <summary>The in-flight background refresh, if any — test seam for stale-while-revalidate.</summary>
    internal Task? RefreshInFlight => Volatile.Read(ref _refreshTask);

    /// <summary>
    ///     Returns the current TLE snapshot, refreshing when stale. A fresh snapshot is served without
    ///     touching upstream; a stale one is served immediately while one background refresh runs (unless
    ///     inside the backoff window, in which case stale is served without any fetch). Cold start fetches
    ///     synchronously and may return null if that first fetch fails.
    /// </summary>
    public async Task<TleSnapshot?> GetAsync(CancellationToken ct)
    {
        var now = _time.GetUtcNow();
        var snap = _snapshot;

        // Fresh: serve directly.
        if (snap is not null && now - snap.FetchedAt < Ttl)
            return snap;

        // Stale snapshot on hand: never block the caller on the network.
        if (snap is not null)
        {
            if (now < _backoffUntil)
            {
                LastReason = "celestrak-backoff";
                return snap;
            }

            TriggerBackgroundRefresh();
            return snap;
        }

        // Cold start, still inside a backoff from a failed first fetch: fail closed, don't fetch.
        if (now < _backoffUntil)
        {
            LastReason = "celestrak-backoff";
            return null;
        }

        return await RefreshUnderGateAsync(ct);
    }

    private void TriggerBackgroundRefresh()
    {
        lock (_refreshLock)
        {
            if (_refreshTask is { IsCompleted: false })
                return;
            _refreshTask = Task.Run(() => RefreshUnderGateAsync(CancellationToken.None));
        }
    }

    private async Task<TleSnapshot?> RefreshUnderGateAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var now = _time.GetUtcNow();

            // Another caller may have refreshed (or armed a backoff) while we waited on the gate.
            if (_snapshot is { } current && now - current.FetchedAt < Ttl)
                return current;
            if (_snapshot is not null && now < _backoffUntil)
                return _snapshot;

            // Development-only fixture short-circuits the network entirely.
            if (TryLoadFixture(out var fixtureSnapshot))
            {
                _snapshot = fixtureSnapshot;
                _backoff = InitialBackoff;
                LastReason = null;
                return fixtureSnapshot;
            }

            var fetched = await FetchCycleAsync(ct);
            if (fetched is not null)
            {
                _snapshot = fetched;
                _backoff = InitialBackoff; // clean cycle resets the backoff ladder
                LastReason = null;
                return fetched;
            }

            // Failed cycle: keep the previous snapshot (may be null) and arm/lengthen the backoff.
            _backoffUntil = _time.GetUtcNow() + _backoff;
            _backoff = TimeSpan.FromTicks(Math.Min(_backoff.Ticks * 2, MaxBackoff.Ticks));
            return _snapshot;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    ///     Pulls every configured group sequentially, spaced by <see cref="RequestSpacing" />, consuming
    ///     one budget unit per request. ANY failure — over budget, non-200, timeout, or a 200 whose body
    ///     is not a JSON array — aborts the whole cycle and returns null so the previous snapshot is kept.
    /// </summary>
    private async Task<TleSnapshot?> FetchCycleAsync(CancellationToken ct)
    {
        var http = _httpFactory.CreateClient("celestrak");
        var collected = new List<(string Group, IReadOnlyList<OmmElements> Records)>();
        var first = true;

        foreach (var group in _options.ParsedGroups())
        {
            if (!first)
                await Task.Delay(RequestSpacing, ct);
            first = false;

            if (!_budget.TryConsume())
            {
                _logger.LogWarning("CelesTrak daily budget exhausted ({Used}/{Limit})", _budget.Used, _budget.Limit);
                LastReason = "celestrak-budget-exhausted";
                return null;
            }

            var records = await FetchGroupAsync(http, group, ct);
            if (records is null)
            {
                LastReason = "tle-unavailable";
                return null; // abort remaining groups — CelesTrak-firewall safety
            }

            collected.Add((group, records));
        }

        return BuildSnapshot(collected);
    }

    /// <summary>
    ///     Fetches one CelesTrak group. Returns null (⇒ abort the cycle) on any non-200 OR on a 200
    ///     whose body does not parse as a JSON array — the plain-text-error-body case. An empty JSON
    ///     array is a valid (empty) group and does NOT abort.
    /// </summary>
    private async Task<IReadOnlyList<OmmElements>?> FetchGroupAsync(HttpClient http, string group, CancellationToken ct)
    {
        try
        {
            // FORMAT=JSON is mandatory: CelesTrak's default flipped to CSV in 2026.
            var url = $"{_options.CelestrakBaseUrl}?GROUP={Uri.EscapeDataString(group)}&FORMAT=JSON";
            using var resp = await http.GetAsync(url, ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("CelesTrak group {Group} returned {Status}", group, resp.StatusCode);
                return null;
            }

            var body = await resp.Content.ReadAsStringAsync(ct);
            return ParseOmmArray(group, body);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "CelesTrak group {Group} fetch failed", group);
            return null;
        }
    }

    /// <summary>
    ///     Parses a CelesTrak response body as an OMM array. Returns null when the body is not a JSON
    ///     array (HTTP 200 + plain-text error) — the caller treats that as a hard failure.
    /// </summary>
    private IReadOnlyList<OmmElements>? ParseOmmArray(string group, string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
            {
                _logger.LogWarning(
                    "CelesTrak group {Group} returned 200 with a non-array body: {Snippet}",
                    group, Snippet(body));
                return null;
            }

            return doc.RootElement.Deserialize<List<OmmElements>>(JsonOptions) ?? [];
        }
        catch (JsonException)
        {
            _logger.LogWarning(
                "CelesTrak group {Group} returned 200 with an unparseable body: {Snippet}",
                group, Snippet(body));
            return null;
        }
    }

    /// <summary>Merge groups into a NORAD-deduped snapshot; higher-precedence groups win.</summary>
    private TleSnapshot BuildSnapshot(IEnumerable<(string Group, IReadOnlyList<OmmElements> Records)> groups)
    {
        var merged = new Dictionary<int, (int Rank, string AppGroup, OmmElements Omm)>();
        foreach (var (group, records) in groups)
        {
            var appGroup = MapGroup(group);
            var rank = GroupRank(appGroup);
            foreach (var omm in records)
            {
                // Lower rank number = higher precedence; keep the incumbent when it outranks us.
                if (merged.TryGetValue(omm.NoradCatId, out var existing) && existing.Rank <= rank)
                    continue;
                merged[omm.NoradCatId] = (rank, appGroup, omm);
            }
        }

        var list = new List<TleRecord>(merged.Count);
        foreach (var (_, appGroup, omm) in merged.Values)
            list.Add(new TleRecord(appGroup, omm));

        return new TleSnapshot(_time.GetUtcNow(), list);
    }

    /// <summary>CelesTrak group name → app-facing group; the four GNSS constellations collapse to "gnss".</summary>
    private static string MapGroup(string celestrakGroup) => celestrakGroup switch
    {
        "stations" => "stations",
        "amateur" => "amateur",
        "weather" => "weather",
        _ => "gnss", // gps-ops / galileo / glo-ops / beidou (and any future GNSS group)
    };

    /// <summary>Dedupe precedence: stations &gt; amateur &gt; weather &gt; gnss (ISS lives in several groups).</summary>
    private static int GroupRank(string appGroup) => appGroup switch
    {
        "stations" => 0,
        "amateur" => 1,
        "weather" => 2,
        _ => 3,
    };

    /// <summary>
    ///     Dev-only fixture load. Honored only in Development with <see cref="SatellitesOptions.TleFile" />
    ///     set and present; outside Development it logs a warning and is ignored (fall through to the
    ///     network). The file is a JSON object keyed by CelesTrak group name — <c>{ "stations": [omm...],
    ///     "amateur": [omm...] }</c> — so it exercises the same merge/dedupe path as a live cycle.
    /// </summary>
    private bool TryLoadFixture([NotNullWhen(true)] out TleSnapshot? snapshot)
    {
        snapshot = null;
        var path = _options.TleFile;
        if (string.IsNullOrWhiteSpace(path))
            return false;

        if (!_env.IsDevelopment())
        {
            _logger.LogWarning(
                "Satellites:TleFile is set but ignored outside Development (environment {Env})",
                _env.EnvironmentName);
            return false;
        }

        var resolved = ResolvePath(path);
        if (!File.Exists(resolved))
        {
            _logger.LogWarning("Satellites:TleFile {Path} not found; falling back to CelesTrak", resolved);
            return false;
        }

        try
        {
            using var stream = File.OpenRead(resolved);
            var byGroup = JsonSerializer.Deserialize<Dictionary<string, List<OmmElements>>>(stream, JsonOptions);
            if (byGroup is null)
                return false;

            snapshot = BuildSnapshot(byGroup.Select(kv =>
                (kv.Key, (IReadOnlyList<OmmElements>)kv.Value)));
            _logger.LogInformation(
                "Loaded {Count} satellites from TLE fixture {Path}", snapshot.Records.Count, resolved);
            return true;
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            _logger.LogWarning(ex, "Failed to load TLE fixture {Path}; falling back to CelesTrak", resolved);
            return false;
        }
    }

    /// <summary>Absolute paths are used as-is; relative paths resolve against the content root (dev).</summary>
    private string ResolvePath(string path) =>
        Path.IsPathRooted(path) ? path : Path.GetFullPath(Path.Combine(_env.ContentRootPath, path));

    private static string Snippet(string body) =>
        body.Length > 80 ? body[..80] : body;
}

/// <summary>An immutable, NORAD-deduped set of satellite elements captured at <see cref="FetchedAt" />.</summary>
public sealed record TleSnapshot(DateTimeOffset FetchedAt, IReadOnlyList<TleRecord> Records);

/// <summary>One satellite in a snapshot: its app-facing group plus the raw OMM elements.</summary>
public sealed record TleRecord(string AppGroup, OmmElements Omm);
