using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Skylens.Api.Enrichment;
using Skylens.Api.Options;
using Xunit;

namespace Skylens.Api.Tests;

/// <summary>
///     Exercises <see cref="CelestrakTleService" /> against a stubbed <see cref="HttpMessageHandler" /> and a
///     <see cref="FakeTimeProvider" />: per-group budget accounting, single-flight, dedupe precedence, the
///     Development-gated fixture load, stale-while-revalidate, and — the CelesTrak-firewall safety
///     invariant — that an HTTP 200 with a plain-text error body aborts the cycle, arms the backoff, and
///     keeps serving the previous snapshot.
/// </summary>
public sealed class CelestrakTleServiceTests
{
    private static readonly DateTimeOffset T0 = new(2026, 7, 11, 12, 0, 0, TimeSpan.Zero);

    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    // The exact shape CelesTrak returns for an invalid query: HTTP 200 with a plain-text body.
    private const string CelestrakPlainTextError =
        "Invalid query: \"GROUP=noaa&FORMAT=JSON\" (GROUP=noaa not found)";

    private static OmmElements MakeOmm(int norad, string name) => new(
        name, "1998-067A", "2026-07-11T07:33:23.712192", 15.48978902, 0.00066885, 51.6302, 180.6822,
        282.4935, 77.5305, 0, "U", norad, 999, 57549, 0.00010843416, 5.525e-05, 0);

    private static string ArrJson(params OmmElements[] items) => JsonSerializer.Serialize(items, Web);

    private static CelestrakTleService CreateService(
        StubHandler handler,
        TimeProvider time,
        string groups,
        UpstreamBudget? budget = null,
        string? tleFile = null,
        bool development = true)
    {
        var options = Microsoft.Extensions.Options.Options.Create(new SatellitesOptions
        {
            Groups = groups,
            CelestrakBaseUrl = "https://celestrak.test/NORAD/elements/gp.php",
            CelestrakDailyBudget = 120,
            TleFile = tleFile,
        });
        budget ??= UpstreamBudget.Daily(120, time);
        var env = new FakeEnv { EnvironmentName = development ? Environments.Development : Environments.Production };
        return new CelestrakTleService(
            new StubHttpClientFactory(handler), options, budget, env, time,
            NullLogger<CelestrakTleService>.Instance)
        {
            RequestSpacing = TimeSpan.Zero, // don't sleep the politeness delay in tests
        };
    }

    // -- Fetch cycle: budget + mapping ---------------------------------------------------------------

    [Fact]
    public async Task GetAsync_fetches_each_group_once_and_consumes_one_budget_unit_per_group()
    {
        var time = new FakeTimeProvider(T0);
        var budget = UpstreamBudget.Daily(120, time);
        var handler = new StubHandler();
        handler.Bodies["amateur"] = ArrJson(MakeOmm(27607, "SO-50"));
        handler.Bodies["stations"] = ArrJson(MakeOmm(25544, "ISS (ZARYA)"));
        handler.Bodies["weather"] = ArrJson(MakeOmm(43013, "NOAA 20"));
        var service = CreateService(handler, time, "amateur,stations,weather", budget);

        var snapshot = await service.GetAsync(TestContext.Current.CancellationToken);

        Assert.NotNull(snapshot);
        Assert.Equal(3, snapshot!.Records.Count);
        Assert.Equal(3, budget.Used);                 // one unit per group
        Assert.Equal(1, handler.GroupCalls("amateur"));
        Assert.Equal(1, handler.GroupCalls("stations"));
        Assert.Equal(1, handler.GroupCalls("weather"));
        Assert.Null(service.LastReason);
        Assert.Equal(T0, service.FetchedAt);
    }

    [Fact]
    public async Task GetAsync_runs_a_single_fetch_cycle_under_concurrency()
    {
        var time = new FakeTimeProvider(T0);
        var release = new TaskCompletionSource();
        var handler = new StubHandler { FirstRequestGate = release.Task };
        handler.Bodies["amateur"] = ArrJson(MakeOmm(27607, "SO-50"));
        handler.Bodies["stations"] = ArrJson(MakeOmm(25544, "ISS (ZARYA)"));
        var service = CreateService(handler, time, "amateur,stations");

        var tasks = Enumerable.Range(0, 10)
                              .Select(_ => service.GetAsync(TestContext.Current.CancellationToken))
                              .ToArray();

        await Task.Delay(50, TestContext.Current.CancellationToken); // let the 10 converge on the gate
        release.SetResult();
        await Task.WhenAll(tasks);

        Assert.Equal(1, handler.GroupCalls("amateur"));
        Assert.Equal(1, handler.GroupCalls("stations"));
        Assert.Equal(2, handler.TotalCalls);
    }

    // -- Dedupe precedence ---------------------------------------------------------------------------

    [Fact]
    public async Task GetAsync_dedupes_by_norad_with_stations_winning_over_amateur()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler();
        // Same NORAD in both groups; amateur is listed FIRST to prove precedence is by group, not order.
        handler.Bodies["amateur"] = ArrJson(MakeOmm(25544, "ISS-AMATEUR"));
        handler.Bodies["stations"] = ArrJson(MakeOmm(25544, "ISS-STATIONS"));
        var service = CreateService(handler, time, "amateur,stations");

        var snapshot = await service.GetAsync(TestContext.Current.CancellationToken);

        var record = Assert.Single(snapshot!.Records);
        Assert.Equal("stations", record.AppGroup);
        Assert.Equal("ISS-STATIONS", record.Omm.ObjectName);
    }

    // -- CelesTrak-firewall safety invariant ---------------------------------------------------------

    [Fact]
    public async Task GetAsync_200_with_plain_text_body_aborts_cycle_arms_backoff_and_serves_stale()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler();
        handler.Bodies["amateur"] = ArrJson(MakeOmm(27607, "SO-50"));
        handler.Bodies["stations"] = ArrJson(MakeOmm(25544, "ISS (ZARYA)"));
        var service = CreateService(handler, time, "amateur,stations");

        // 1) A clean first cycle populates the snapshot.
        var first = await service.GetAsync(TestContext.Current.CancellationToken);
        Assert.NotNull(first);
        Assert.Equal(2, first!.Records.Count);

        // 2) Age the snapshot past its TTL, then make the FIRST group return CelesTrak's 200-plain-text.
        time.Advance(TimeSpan.FromHours(2) + TimeSpan.FromMinutes(1));
        handler.Bodies["amateur"] = CelestrakPlainTextError; // HTTP 200, non-JSON body

        // The stale snapshot is served immediately; the refresh runs in the background.
        var served = await service.GetAsync(TestContext.Current.CancellationToken);
        Assert.Same(first, served);
        await service.RefreshInFlight!;

        // The refresh aborted on the bad body: previous snapshot kept, only the first group was hit.
        Assert.Equal(first.FetchedAt, service.FetchedAt);
        Assert.Equal("tle-unavailable", service.LastReason);
        Assert.Equal(2, handler.GroupCalls("amateur")); // 1 clean + 1 aborted refresh
        Assert.Equal(1, handler.GroupCalls("stations")); // never reached on the aborted cycle

        // 3) A follow-up call within the backoff window serves stale WITHOUT any new fetch.
        var again = await service.GetAsync(TestContext.Current.CancellationToken);
        Assert.Same(first, again);
        Assert.Equal("celestrak-backoff", service.LastReason);
        Assert.Equal(2, handler.GroupCalls("amateur")); // unchanged — no fetch during backoff
    }

    [Fact]
    public async Task GetAsync_non_200_on_cold_start_aborts_and_fails_closed()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { Status = HttpStatusCode.ServiceUnavailable };
        handler.Bodies["stations"] = ArrJson(MakeOmm(25544, "ISS (ZARYA)"));
        var budget = UpstreamBudget.Daily(120, time);
        var service = CreateService(handler, time, "stations", budget);

        var snapshot = await service.GetAsync(TestContext.Current.CancellationToken);

        Assert.Null(snapshot);
        Assert.Null(service.FetchedAt);
        Assert.Equal("tle-unavailable", service.LastReason);
        Assert.Equal(1, budget.Used); // the one attempted group still spent its unit
    }

    [Fact]
    public async Task GetAsync_backoff_expires_and_a_later_call_retries_successfully()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { Status = HttpStatusCode.ServiceUnavailable };
        handler.Bodies["stations"] = ArrJson(MakeOmm(25544, "ISS (ZARYA)"));
        var service = CreateService(handler, time, "stations");

        // Cold start fails → null + backoff armed.
        Assert.Null(await service.GetAsync(TestContext.Current.CancellationToken));
        Assert.Equal(1, handler.TotalCalls);

        // Still inside the backoff window: served closed WITHOUT another fetch.
        Assert.Null(await service.GetAsync(TestContext.Current.CancellationToken));
        Assert.Equal("celestrak-backoff", service.LastReason);
        Assert.Equal(1, handler.TotalCalls);

        // Past the 30-minute backoff and CelesTrak recovers: the retry succeeds.
        time.Advance(TimeSpan.FromMinutes(31));
        handler.Status = HttpStatusCode.OK;
        var snapshot = await service.GetAsync(TestContext.Current.CancellationToken);

        Assert.NotNull(snapshot);
        Assert.Single(snapshot!.Records);
        Assert.Null(service.LastReason);
        Assert.Equal(2, handler.TotalCalls);
    }

    // -- Stale-while-revalidate ----------------------------------------------------------------------

    [Fact]
    public async Task GetAsync_serves_a_cached_snapshot_within_the_ttl_without_refetching()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler();
        handler.Bodies["stations"] = ArrJson(MakeOmm(25544, "ISS (ZARYA)"));
        var service = CreateService(handler, time, "stations");

        var first = await service.GetAsync(TestContext.Current.CancellationToken);
        time.Advance(TimeSpan.FromHours(1)); // well within the 2 h TTL
        var second = await service.GetAsync(TestContext.Current.CancellationToken);

        Assert.Same(first, second);
        Assert.Single(second!.Records);
        Assert.Equal(1, handler.TotalCalls);
    }

    [Fact]
    public async Task GetAsync_serves_stale_immediately_then_refreshes_in_the_background()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler();
        handler.Bodies["stations"] = ArrJson(MakeOmm(25544, "ISS (ZARYA)"));
        var service = CreateService(handler, time, "stations");

        var first = await service.GetAsync(TestContext.Current.CancellationToken);
        time.Advance(TimeSpan.FromHours(2) + TimeSpan.FromMinutes(1)); // past TTL

        // The stale snapshot comes back immediately; a background refresh is kicked off.
        var stale = await service.GetAsync(TestContext.Current.CancellationToken);
        Assert.Same(first, stale);
        await service.RefreshInFlight!;

        // After the refresh completes, the snapshot is replaced with a freshly-timestamped one.
        var fresh = await service.GetAsync(TestContext.Current.CancellationToken);
        Assert.NotSame(first, fresh);
        Assert.True(fresh!.FetchedAt > first!.FetchedAt);
        Assert.Equal(2, handler.TotalCalls);
    }

    // -- Development-gated fixture load --------------------------------------------------------------

    [Fact]
    public async Task GetAsync_loads_the_tle_fixture_file_without_any_network_in_development()
    {
        var time = new FakeTimeProvider(T0);
        var budget = UpstreamBudget.Daily(120, time);
        var handler = new StubHandler { Status = HttpStatusCode.InternalServerError }; // would fail if touched
        var fixture = Path.Combine(AppContext.BaseDirectory, "fixtures", "tle.json");
        var service = CreateService(handler, time, "amateur,stations", budget, tleFile: fixture, development: true);

        var snapshot = await service.GetAsync(TestContext.Current.CancellationToken);

        Assert.NotNull(snapshot);
        Assert.Equal(0, handler.TotalCalls); // fixture load never hits the network
        Assert.Equal(0, budget.Used);        // and never spends budget
        Assert.Null(service.LastReason);
        // 22 records in the fixture, 21 distinct — ISS (25544) is a real stations+amateur crossover.
        Assert.Equal(21, snapshot!.Records.Count);
        var iss = Assert.Single(snapshot.Records, r => r.Omm.NoradCatId == 25544);
        Assert.Equal("stations", iss.AppGroup); // dedupe kept the higher-precedence group
    }

    [Fact]
    public async Task GetAsync_ignores_the_tle_fixture_outside_development_and_uses_the_network()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler();
        handler.Bodies["stations"] = ArrJson(MakeOmm(25544, "ISS (ZARYA)"));
        var fixture = Path.Combine(AppContext.BaseDirectory, "fixtures", "tle.json");
        var service = CreateService(handler, time, "stations", tleFile: fixture, development: false);

        var snapshot = await service.GetAsync(TestContext.Current.CancellationToken);

        Assert.NotNull(snapshot);
        Assert.Equal(1, handler.TotalCalls);  // fixture ignored → real fetch happened
        Assert.Single(snapshot!.Records);     // the network's single record, not the fixture's 21
    }

    /// <summary>
    ///     Serves canned per-group bodies for CelesTrak GP requests and counts calls per group. Any body
    ///     may be non-JSON (to simulate the 200-plain-text error) and <see cref="Status" /> flips every
    ///     response to a non-200. <see cref="FirstRequestGate" /> holds the very first request so a test
    ///     can prove the fetch cycle runs once under concurrency.
    /// </summary>
    private sealed class StubHandler : HttpMessageHandler
    {
        private int _totalCalls;
        private readonly ConcurrentDictionary<string, int> _groupCalls = new(StringComparer.Ordinal);

        public Dictionary<string, string> Bodies { get; } = new(StringComparer.Ordinal);
        public HttpStatusCode Status { get; set; } = HttpStatusCode.OK;
        public Task? FirstRequestGate { get; init; }

        public int TotalCalls => Volatile.Read(ref _totalCalls);
        public int GroupCalls(string group) => _groupCalls.TryGetValue(group, out var n) ? n : 0;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var group = ExtractGroup(request.RequestUri!.Query);
            _groupCalls.AddOrUpdate(group, 1, static (_, n) => n + 1);

            if (Interlocked.Increment(ref _totalCalls) == 1 && FirstRequestGate is not null)
                await FirstRequestGate.WaitAsync(ct);

            var body = Bodies.TryGetValue(group, out var b) ? b : "[]";
            return new HttpResponseMessage(Status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
        }

        private static string ExtractGroup(string query)
        {
            foreach (var part in query.TrimStart('?').Split('&'))
            {
                if (part.StartsWith("GROUP=", StringComparison.Ordinal))
                    return Uri.UnescapeDataString(part["GROUP=".Length..]);
            }

            return string.Empty;
        }
    }

    private sealed class StubHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class FakeEnv : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = Environments.Development;
        public string ApplicationName { get; set; } = "Skylens.Api.Tests";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
