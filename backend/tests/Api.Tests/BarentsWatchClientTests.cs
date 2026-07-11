using System.Net;
using System.Text;
using Xunit;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using Skylens.Api.Endpoints;
using Skylens.Api.Enrichment;
using Skylens.Api.Options;

namespace Skylens.Api.Tests;

/// <summary>
///     Exercises <see cref="BarentsWatchClient" /> against a stubbed <see cref="HttpMessageHandler" /> and a
///     <see cref="FakeTimeProvider" />: OAuth token caching/single-flight, away-mode fail-closed + mapping +
///     snapshot caching + radius filter, and the per-MMSI static lookup. The <c>/api/vessels/{mmsi}</c>
///     merge precedence is covered via <see cref="ApiEndpoints.MergeVesselMetadata" /> directly.
/// </summary>
public sealed class BarentsWatchClientTests
{
    private static readonly DateTimeOffset T0 = new(2026, 7, 11, 12, 0, 0, TimeSpan.Zero);

    // Tromsø-ish viewer; BALDER sits ~11 km away (inside), the "far" ship ~1300 km south (outside).
    private const double ViewerLat = 69.6;
    private const double ViewerLon = 18.0;

    private const string TokenJson = """{"access_token":"tok-abc","token_type":"Bearer","expires_in":3600}""";

    private static string SnapshotJson(bool includeFar = true)
    {
        var balder =
            """{"mmsi":257011940,"name":"BALDER","shipType":33,"latitude":69.543985,"longitude":17.769428,"speedOverGround":0.0,"courseOverGround":356.7,"trueHeading":null,"navigationalStatus":0,"msgtime":"2026-07-11T12:00:00+00:00","callSign":"LABC","destination":"TROMSO","eta":"07-12T08:00","imoNumber":9271819,"draught":57,"dimensionA":19,"dimensionB":7,"dimensionC":2,"dimensionD":5}""";
        var far =
            """{"mmsi":258216000,"name":"EIGENES","shipType":30,"latitude":58.0,"longitude":5.0,"speedOverGround":0.8,"courseOverGround":322.1,"trueHeading":100,"navigationalStatus":7,"msgtime":"2026-07-11T12:00:00+00:00"}""";
        return includeFar ? $"[{balder},{far}]" : $"[{balder}]";
    }

    private static BarentsWatchClient CreateClient(
        StubHandler handler,
        TimeProvider time,
        UpstreamBudget? budget = null,
        bool configured = true,
        EnrichmentCache? cache = null)
    {
        var http = new HttpClient(handler);
        var options = Microsoft.Extensions.Options.Options.Create(new BarentsWatchOptions
        {
            ClientId = configured ? "id" : null,
            ClientSecret = configured ? "secret" : null,
            TokenEndpoint = "https://id.barentswatch.test/connect/token",
            BaseUrl = "https://live.ais.barentswatch.test",
            DailyBudget = 2000,
        });
        cache ??= new EnrichmentCache(new MemoryCache(new MemoryCacheOptions()));
        budget ??= UpstreamBudget.Daily(2000, time);
        return new BarentsWatchClient(http, options, cache, budget, time, NullLogger<BarentsWatchClient>.Instance);
    }

    // -- Away-mode: fail-closed paths ----------------------------------------------------------------

    [Fact]
    public async Task GetAsync_unconfigured_yields_empty_with_reason_and_no_http()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler();
        var client = CreateClient(handler, time, configured: false);

        var result = await client.GetAsync(ViewerLat, ViewerLon, 300, TestContext.Current.CancellationToken);

        Assert.Empty(result.Vessels);
        Assert.Equal("away-mode-unconfigured", result.Reason);
        Assert.Equal(0, handler.TotalCalls);
    }

    [Fact]
    public async Task GetAsync_budget_exhausted_fails_closed_without_fetching()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler();
        var client = CreateClient(handler, time, budget: UpstreamBudget.Daily(0, time));

        var result = await client.GetAsync(ViewerLat, ViewerLon, 300, TestContext.Current.CancellationToken);

        Assert.Empty(result.Vessels);
        Assert.Equal("barentswatch-budget-exhausted", result.Reason);
        Assert.Equal(0, handler.TotalCalls); // never touched the token or snapshot endpoints
    }

    [Fact]
    public async Task GetAsync_token_failure_surfaces_reason_not_exception()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { TokenStatus = HttpStatusCode.Unauthorized };
        var client = CreateClient(handler, time);

        var result = await client.GetAsync(ViewerLat, ViewerLon, 300, TestContext.Current.CancellationToken);

        Assert.Empty(result.Vessels);
        Assert.Equal("barentswatch-unavailable", result.Reason);
        Assert.Equal(1, handler.TokenCalls);
        Assert.Equal(0, handler.SnapshotCalls); // no token ⇒ no snapshot GET
    }

    // -- Away-mode: happy path -----------------------------------------------------------------------

    [Fact]
    public async Task GetAsync_maps_the_combined_model_to_vessel_dtos()
    {
        // Msgtime is T0; the fake clock is 30 s later ⇒ Seen == 30.
        var time = new FakeTimeProvider(T0.AddSeconds(30));
        var handler = new StubHandler { SnapshotBody = SnapshotJson(includeFar: false) };
        var client = CreateClient(handler, time);

        var result = await client.GetAsync(ViewerLat, ViewerLon, 300, TestContext.Current.CancellationToken);

        var dto = Assert.Single(result.Vessels);
        Assert.Null(result.Reason);
        Assert.Equal("257011940", dto.Mmsi);
        Assert.Equal("BALDER", dto.Name);
        Assert.Equal("ship", dto.Kind);
        Assert.Equal(33, dto.ShipType);
        Assert.Equal(0.0, dto.Sog);
        Assert.Equal(356.7, dto.Cog);
        Assert.Null(dto.Hdg);          // trueHeading was null
        Assert.Equal(0, dto.NavStatus);
        Assert.Null(dto.Flag);         // combined model carries no country/flag
        Assert.Equal("barentswatch", dto.Src);
        Assert.Equal(30, dto.Seen);
    }

    [Fact]
    public async Task GetAsync_filters_out_vessels_beyond_the_radius()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { SnapshotBody = SnapshotJson(includeFar: true) };
        var client = CreateClient(handler, time);

        var result = await client.GetAsync(ViewerLat, ViewerLon, 100, TestContext.Current.CancellationToken);

        // BALDER is ~11 km away (kept); EIGENES is ~1300 km south (dropped).
        var dto = Assert.Single(result.Vessels);
        Assert.Equal("257011940", dto.Mmsi);
    }

    [Fact]
    public async Task GetAsync_serves_a_cached_snapshot_without_a_second_fetch()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { SnapshotBody = SnapshotJson() };
        var client = CreateClient(handler, time);

        await client.GetAsync(ViewerLat, ViewerLon, 300, TestContext.Current.CancellationToken);
        // Well within the 60 s snapshot TTL: served from cache, no second upstream call.
        time.Advance(TimeSpan.FromSeconds(5));
        await client.GetAsync(ViewerLat, ViewerLon, 300, TestContext.Current.CancellationToken);

        Assert.Equal(1, handler.SnapshotCalls);
        Assert.Equal(1, handler.TokenCalls);
    }

    [Fact]
    public async Task GetAsync_refetches_after_ttl_but_reuses_the_cached_token()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { SnapshotBody = SnapshotJson() };
        var client = CreateClient(handler, time);

        await client.GetAsync(ViewerLat, ViewerLon, 300, TestContext.Current.CancellationToken);
        time.Advance(TimeSpan.FromSeconds(61)); // snapshot TTL expired, token (3600 s) still valid
        await client.GetAsync(ViewerLat, ViewerLon, 300, TestContext.Current.CancellationToken);

        Assert.Equal(2, handler.SnapshotCalls); // snapshot refetched
        Assert.Equal(1, handler.TokenCalls);    // token cached across the two fetches
    }

    [Fact]
    public async Task GetAsync_runs_token_and_snapshot_once_under_concurrency()
    {
        var time = new FakeTimeProvider(T0);
        var release = new TaskCompletionSource();
        var handler = new StubHandler { SnapshotBody = SnapshotJson(), SnapshotGate = release.Task };
        var client = CreateClient(handler, time);

        var tasks = Enumerable.Range(0, 10)
                              .Select(_ => client.GetAsync(ViewerLat, ViewerLon, 300, TestContext.Current.CancellationToken))
                              .ToArray();

        await Task.Delay(50, TestContext.Current.CancellationToken); // let the 10 converge on the gate
        release.SetResult();
        await Task.WhenAll(tasks);

        Assert.Equal(1, handler.TokenCalls);
        Assert.Equal(1, handler.SnapshotCalls);
    }

    // -- Detail lookup -------------------------------------------------------------------------------

    [Fact]
    public async Task LookupAsync_unconfigured_returns_null_without_http()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler();
        var client = CreateClient(handler, time, configured: false);

        var meta = await client.LookupAsync("257011940", TestContext.Current.CancellationToken);

        Assert.Null(meta);
        Assert.Equal(0, handler.TotalCalls);
    }

    [Fact]
    public async Task LookupAsync_maps_static_fields_and_caches_within_ttl()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { FilterBody = SnapshotJson(includeFar: false) };
        var client = CreateClient(handler, time);

        var meta = await client.LookupAsync("257011940", TestContext.Current.CancellationToken);

        Assert.NotNull(meta);
        Assert.Equal("257011940", meta!.Mmsi);
        Assert.Equal("LABC", meta.CallSign);
        Assert.Equal(9271819, meta.Imo);
        Assert.Equal("TROMSO", meta.Destination);
        Assert.Equal("07-12T08:00", meta.Eta);
        Assert.Equal(5.7, meta.Draught);          // 57 decimetres → 5.7 m
        Assert.Equal(19, meta.DimBow);
        Assert.Equal(7, meta.DimStern);
        Assert.Equal(2, meta.DimPort);
        Assert.Equal(5, meta.DimStarboard);
        Assert.Equal("barentswatch", meta.Source);

        // A second lookup within the 6 h TTL is served from the cache — no second upstream POST.
        time.Advance(TimeSpan.FromHours(1));
        await client.LookupAsync("257011940", TestContext.Current.CancellationToken);
        Assert.Equal(1, handler.FilterCalls);
    }

    [Fact]
    public async Task LookupAsync_budget_exhausted_returns_null()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { FilterBody = SnapshotJson(includeFar: false) };
        var client = CreateClient(handler, time, budget: UpstreamBudget.Daily(0, time));

        var meta = await client.LookupAsync("257011940", TestContext.Current.CancellationToken);

        Assert.Null(meta);
        Assert.Equal(0, handler.FilterCalls); // fails closed before any upstream POST
    }

    // -- Merge precedence (the /api/vessels/{mmsi} enrichment seam) -----------------------------------

    [Fact]
    public void MergeVesselMetadata_state_wins_upstream_fills_nulls()
    {
        var local = new VesselMetadata
        {
            Mmsi = "257011940",
            CallSign = "LOCAL",
            Destination = null,
            Imo = null,
            Source = "ais",
        };
        var upstream = new VesselMetadata
        {
            Mmsi = "257011940",
            CallSign = "UPSTREAM",
            Destination = "BERGEN",
            Imo = 9271819,
            Draught = 5.7,
            Source = "barentswatch",
        };

        var merged = ApiEndpoints.MergeVesselMetadata(local, upstream)!;

        Assert.Equal("LOCAL", merged.CallSign);      // state wins
        Assert.Equal("BERGEN", merged.Destination);  // BW fills the null
        Assert.Equal(9271819, merged.Imo);           // BW fills the null
        Assert.Equal(5.7, merged.Draught);           // BW fills the null
        Assert.Equal("ais", merged.Source);          // provenance stays the local feed's
    }

    [Fact]
    public void MergeVesselMetadata_passes_through_a_single_half()
    {
        var upstream = new VesselMetadata { Mmsi = "1", CallSign = "UP", Source = "barentswatch" };

        Assert.Same(upstream, ApiEndpoints.MergeVesselMetadata(null, upstream));
        Assert.Null(ApiEndpoints.MergeVesselMetadata(null, null));
    }

    [Fact]
    public void HasStaticData_is_true_only_when_a_voyage_field_is_present()
    {
        Assert.False(ApiEndpoints.HasStaticData(null));
        Assert.False(ApiEndpoints.HasStaticData(new VesselMetadata { Mmsi = "1" }));
        Assert.True(ApiEndpoints.HasStaticData(new VesselMetadata { Mmsi = "1", CallSign = "LABC" }));
        Assert.True(ApiEndpoints.HasStaticData(new VesselMetadata { Mmsi = "1", Imo = 9271819 }));
    }

    /// <summary>
    ///     Routes BarentsWatch's three request shapes (token POST, snapshot GET, per-MMSI filter POST) to
    ///     canned bodies and counts each. <see cref="SnapshotGate" /> lets a test hold callers inside the
    ///     snapshot single-flight to prove it runs once.
    /// </summary>
    private sealed class StubHandler : HttpMessageHandler
    {
        private int _tokenCalls;
        private int _snapshotCalls;
        private int _filterCalls;

        public HttpStatusCode TokenStatus { get; init; } = HttpStatusCode.OK;
        public string SnapshotBody { get; init; } = "[]";
        public string FilterBody { get; init; } = "[]";
        public Task? SnapshotGate { get; init; }

        public int TokenCalls => Volatile.Read(ref _tokenCalls);
        public int SnapshotCalls => Volatile.Read(ref _snapshotCalls);
        public int FilterCalls => Volatile.Read(ref _filterCalls);
        public int TotalCalls => TokenCalls + SnapshotCalls + FilterCalls;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var uri = request.RequestUri!.AbsoluteUri;

            if (uri.Contains("connect/token", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref _tokenCalls);
                return Json(TokenStatus, TokenStatus == HttpStatusCode.OK ? TokenJson : "");
            }

            if (request.Method == HttpMethod.Post)
            {
                Interlocked.Increment(ref _filterCalls);
                return Json(HttpStatusCode.OK, FilterBody);
            }

            Interlocked.Increment(ref _snapshotCalls);
            if (SnapshotGate is not null)
                await SnapshotGate.WaitAsync(ct);
            return Json(HttpStatusCode.OK, SnapshotBody);
        }

        private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
    }
}
