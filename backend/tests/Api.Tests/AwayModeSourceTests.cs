using System.Net;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Skylens.Api.Broadcast;
using Skylens.Api.Enrichment;
using Skylens.Api.Options;
using Skylens.Api.State;
using Xunit;

namespace Skylens.Api.Tests;

/// <summary>
///     Exercises the aircraft away-mode sources (<see cref="AdsbLolClient" />, <see cref="AdsbxClient" />
///     via <see cref="ReadsbPointSource" />) and the <see cref="AwayModeChain" /> against a stubbed
///     <see cref="HttpMessageHandler" /> and a <see cref="FakeTimeProvider" />: cell-centre queries,
///     shared per-cell caching, failure caching, fail-closed budgets and provider fallback order.
/// </summary>
public sealed class AwayModeSourceTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 26, 12, 0, 0, TimeSpan.Zero);

    // Bergen-ish viewer: cell (120, 10) → centre 60.25 / 5.25. NEAR is ~6 km away, FAR ~150 km.
    private const double ViewerLat = 60.39;
    private const double ViewerLon = 5.32;

    private const string Body =
        """
        {"ac":[
          {"hex":"4AC9E1","flight":"SAS4123 ","lat":60.42,"lon":5.25,"alt_baro":12000,"gs":320.5,"track":95.0,"baro_rate":-640,"category":"A3","seen":0.4},
          {"hex":"478123","flight":"NOZ612","lat":61.7,"lon":5.9,"alt_baro":"ground","gs":0,"track":0,"category":"A3","seen":1.2},
          {"hex":"abc000","flight":"NOPOS"}
        ],"msg":"No error","now":1793016000000,"total":3,"ctime":1793016000000,"ptime":3}
        """;

    private static AdsbLolClient Lol(StubHandler handler, TimeProvider time, UpstreamBudget? budget = null, bool enabled = true) =>
        new(new HttpClient(handler),
            Microsoft.Extensions.Options.Options.Create(new AdsbLolOptions { Enabled = enabled, BaseUrl = "https://api.adsblol.test" }),
            budget ?? UpstreamBudget.Daily(100, time),
            time,
            NullLogger<AdsbLolClient>.Instance);

    private static AdsbxClient Adsbx(StubHandler handler, TimeProvider time, bool configured = true) =>
        new(new HttpClient(handler),
            Microsoft.Extensions.Options.Options.Create(new AdsbxOptions
            {
                RapidApiKey = configured ? "key" : null,
                RapidApiHost = "adsbx.rapidapi.test",
            }),
            UpstreamBudget.Monthly(100, time),
            time,
            NullLogger<AdsbxClient>.Instance);

    // -- adsb.lol: request shape + mapping ------------------------------------------------------------

    [Fact]
    public async Task AdsbLol_queries_cell_centre_with_padded_radius_and_filters_to_viewer()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { LolBody = Body };
        var client = Lol(handler, time);

        var result = await client.GetAsync(ViewerLat, ViewerLon, 60, TestContext.Current.CancellationToken);

        Assert.Null(result.StatusReason);
        var uri = Assert.Single(handler.Requests);
        // The provider sees the cell centre, never the viewer's own position.
        Assert.StartsWith("https://api.adsblol.test/v2/point/60.25/5.25/", uri, StringComparison.Ordinal);
        Assert.DoesNotContain("60.39", uri, StringComparison.Ordinal);
        // 60 km radius + the cell's centre-to-corner distance (~31 km here), in nautical miles.
        var nm = double.Parse(uri[(uri.LastIndexOf('/') + 1)..], System.Globalization.CultureInfo.InvariantCulture);
        Assert.InRange(nm, (60 + 25) / 1.852, (60 + 40) / 1.852);

        // Only the positioned aircraft within 60 km of the VIEWER survives; FAR and NOPOS are dropped.
        var a = Assert.Single(result.Aircraft);
        Assert.Equal("4ac9e1", a.Hex);
        Assert.Equal("SAS4123", a.Flight);
        Assert.Equal(12000, a.Alt);
        Assert.Equal(120, a.Fl);
        Assert.Equal(-640, a.Vr);
        Assert.Equal("adsblol", a.Src);
    }

    [Fact]
    public async Task AdsbLol_ground_altitude_maps_to_null()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { LolBody = Body };
        var client = Lol(handler, time);

        // Viewer near the "ground" aircraft (61.7 / 5.9): cell (123, 11).
        var result = await client.GetAsync(61.7, 5.9, 20, TestContext.Current.CancellationToken);

        var a = Assert.Single(result.Aircraft);
        Assert.Equal("478123", a.Hex);
        Assert.Null(a.Alt);
        Assert.Null(a.Fl);
    }

    [Fact]
    public async Task AdsbLol_disabled_yields_reason_without_http()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { LolBody = Body };
        var client = Lol(handler, time, enabled: false);

        var result = await client.GetAsync(ViewerLat, ViewerLon, 60, TestContext.Current.CancellationToken);

        Assert.Equal("adsblol-unconfigured", result.StatusReason);
        Assert.Empty(result.Aircraft);
        Assert.Empty(handler.Requests);
    }

    // -- Shared cell cache ----------------------------------------------------------------------------

    [Fact]
    public async Task Viewers_in_the_same_cell_share_one_fetch_until_the_interval_elapses()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { LolBody = Body };
        var client = Lol(handler, time);
        var ct = TestContext.Current.CancellationToken;

        await client.GetAsync(ViewerLat, ViewerLon, 60, ct);
        await client.GetAsync(60.10, 5.05, 60, ct); // same cell, different viewer
        time.Advance(TimeSpan.FromSeconds(9));
        await client.GetAsync(ViewerLat, ViewerLon, 60, ct);
        Assert.Single(handler.Requests);

        time.Advance(TimeSpan.FromSeconds(2));
        await client.GetAsync(ViewerLat, ViewerLon, 60, ct);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task A_wider_viewer_refetches_but_a_narrower_one_reuses_the_cache()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { LolBody = Body };
        var client = Lol(handler, time);
        var ct = TestContext.Current.CancellationToken;

        await client.GetAsync(ViewerLat, ViewerLon, 60, ct);
        await client.GetAsync(ViewerLat, ViewerLon, 30, ct);
        Assert.Single(handler.Requests);

        await client.GetAsync(ViewerLat, ViewerLon, 200, ct);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task Concurrent_viewers_in_a_cell_trigger_a_single_fetch()
    {
        var time = new FakeTimeProvider(T0);
        var gate = new TaskCompletionSource();
        var handler = new StubHandler { LolBody = Body, Gate = gate.Task };
        var client = Lol(handler, time);
        var ct = TestContext.Current.CancellationToken;

        var calls = Enumerable.Range(0, 5).Select(_ => client.GetAsync(ViewerLat, ViewerLon, 60, ct)).ToList();
        gate.SetResult();
        var results = await Task.WhenAll(calls);

        Assert.Single(handler.Requests);
        Assert.All(results, r => Assert.Single(r.Aircraft));
    }

    // -- Failure + budget -----------------------------------------------------------------------------

    [Fact]
    public async Task Upstream_failure_is_cached_for_the_interval_then_retried()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { LolStatus = HttpStatusCode.ServiceUnavailable };
        var client = Lol(handler, time);
        var ct = TestContext.Current.CancellationToken;

        var first = await client.GetAsync(ViewerLat, ViewerLon, 60, ct);
        var second = await client.GetAsync(ViewerLat, ViewerLon, 60, ct);

        Assert.Equal("adsblol-upstream-error", first.StatusReason);
        Assert.Equal("adsblol-upstream-error", second.StatusReason);
        Assert.Single(handler.Requests); // the 1 Hz loop must not hammer a broken upstream

        time.Advance(TimeSpan.FromSeconds(11));
        await client.GetAsync(ViewerLat, ViewerLon, 60, ct);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task Exhausted_budget_fails_closed_without_http()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { LolBody = Body };
        var client = Lol(handler, time, UpstreamBudget.Daily(1, time));
        var ct = TestContext.Current.CancellationToken;

        await client.GetAsync(ViewerLat, ViewerLon, 60, ct);
        time.Advance(TimeSpan.FromSeconds(11));
        var result = await client.GetAsync(ViewerLat, ViewerLon, 60, ct);

        Assert.Equal("adsblol-budget-exhausted", result.StatusReason);
        Assert.Single(handler.Requests);
    }

    // -- Chain ----------------------------------------------------------------------------------------

    [Fact]
    public async Task Chain_serves_adsblol_and_never_touches_adsbx_when_it_answers()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { LolBody = Body, AdsbxBody = Body };
        var chain = new AwayModeChain([Lol(handler, time), Adsbx(handler, time)]);

        var result = await chain.GetAsync(ViewerLat, ViewerLon, 60, TestContext.Current.CancellationToken);

        Assert.Equal("adsblol", Assert.Single(result.Aircraft).Src);
        Assert.All(handler.Requests, u => Assert.Contains("adsblol.test", u, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Chain_falls_back_to_adsbx_when_adsblol_fails()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { LolStatus = HttpStatusCode.BadGateway, AdsbxBody = Body };
        var chain = new AwayModeChain([Lol(handler, time), Adsbx(handler, time)]);

        var result = await chain.GetAsync(ViewerLat, ViewerLon, 60, TestContext.Current.CancellationToken);

        Assert.Null(result.StatusReason);
        Assert.Equal("adsbx", Assert.Single(result.Aircraft).Src);
        Assert.Contains(handler.Requests, u => u.StartsWith("https://adsbx.rapidapi.test/v2/lat/60.25/lon/5.25/dist/", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Chain_without_adsbx_key_surfaces_the_adsblol_reason()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { LolStatus = HttpStatusCode.TooManyRequests };
        var chain = new AwayModeChain([Lol(handler, time), Adsbx(handler, time, configured: false)]);

        var result = await chain.GetAsync(ViewerLat, ViewerLon, 60, TestContext.Current.CancellationToken);

        Assert.Equal("adsblol-upstream-error", result.StatusReason);
        Assert.DoesNotContain(handler.Requests, u => u.Contains("rapidapi", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Chain_with_nothing_configured_reports_unconfigured()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler();
        var chain = new AwayModeChain([Lol(handler, time, enabled: false), Adsbx(handler, time, configured: false)]);

        var result = await chain.GetAsync(ViewerLat, ViewerLon, 60, TestContext.Current.CancellationToken);

        Assert.Equal("away-mode-unconfigured", result.StatusReason);
        Assert.Empty(handler.Requests);
    }

    // -- Cell geometry --------------------------------------------------------------------------------

    [Theory]
    [InlineData(60.39, 5.32, 120, 10)]
    [InlineData(-33.9, 151.2, -68, 302)]
    [InlineData(0.0, -0.1, 0, -1)]
    public void CellOf_floors_into_half_degree_cells(double lat, double lon, int row, int col) =>
        Assert.Equal((row, col), ReadsbPointSource.CellOf(lat, lon));

    [Fact]
    public void Half_diagonal_covers_every_corner_of_the_cell()
    {
        var cell = ReadsbPointSource.CellOf(ViewerLat, ViewerLon);
        var (lat, lon) = ReadsbPointSource.CellCenter(cell);
        var half = ReadsbPointSource.CellHalfDiagonalKm(cell);
        foreach (var (dLat, dLon) in new[] { (-0.25, -0.25), (-0.25, 0.25), (0.25, -0.25), (0.25, 0.25) })
            Assert.True(Geo.DistanceKm(lat, lon, lat + dLat, lon + dLon) <= half + 1e-9);
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly List<string> _requests = [];

        public string LolBody { get; init; } = """{"ac":[]}""";
        public HttpStatusCode LolStatus { get; init; } = HttpStatusCode.OK;
        public string AdsbxBody { get; init; } = """{"ac":[]}""";
        public Task? Gate { get; init; }

        public IReadOnlyList<string> Requests
        {
            get
            {
                lock (_requests)
                    return _requests.ToList();
            }
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var uri = request.RequestUri!.AbsoluteUri;
            lock (_requests)
                _requests.Add(uri);
            if (Gate is not null)
                await Gate;

            var lol = uri.Contains("adsblol.test", StringComparison.Ordinal);
            var status = lol ? LolStatus : HttpStatusCode.OK;
            return new HttpResponseMessage(status)
            {
                Content = new StringContent(lol ? LolBody : AdsbxBody, Encoding.UTF8, "application/json"),
            };
        }
    }
}
