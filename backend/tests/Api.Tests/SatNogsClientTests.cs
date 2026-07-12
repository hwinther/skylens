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
///     Exercises <see cref="SatNogsClient" /> against a stubbed <see cref="HttpMessageHandler" /> and a
///     <see cref="FakeTimeProvider" />: lazy one-shot load, NORAD-keyed dictionary build (null NORAD
///     skipped), the "best active downlink" <see cref="SatNogsClient.FreqSummary(IReadOnlyList{SatelliteTransmitterDto})" />
///     formatter, stale-ok-forever on a failed refresh, and the Development-gated fixture load.
/// </summary>
public sealed class SatNogsClientTests
{
    private static readonly DateTimeOffset T0 = new(2026, 7, 11, 12, 0, 0, TimeSpan.Zero);

    private static Dictionary<string, object?> Tx(
        int? norad, string status, bool alive, long? downlinkLow, string? mode, string type = "Transmitter") => new()
    {
        ["description"] = "test transmitter",
        ["type"] = type,
        ["downlink_low"] = downlinkLow,
        ["downlink_high"] = null,
        ["uplink_low"] = null,
        ["uplink_high"] = null,
        ["mode"] = mode,
        ["baud"] = 1200.0,
        ["norad_cat_id"] = norad,
        ["status"] = status,
        ["alive"] = alive,
    };

    // SatNOGS returns a bare JSON array of transmitter objects; keys are written verbatim (snake_case).
    private static string ArrayJson(params Dictionary<string, object?>[] txs) => JsonSerializer.Serialize(txs);

    private static SatelliteTransmitterDto Dto(
        long? downlinkLow, string? mode, string status, bool alive, string? type = "Transmitter") =>
        new("desc", type, downlinkLow, null, null, null, mode, 1200, status, alive);

    private static SatNogsClient CreateClient(
        StubHandler handler,
        TimeProvider time,
        UpstreamBudget? budget = null,
        string? transmittersFile = null,
        bool development = true)
    {
        var options = Microsoft.Extensions.Options.Options.Create(new SatellitesOptions
        {
            SatNogsBaseUrl = "https://db.satnogs.test",
            SatNogsDailyBudget = 60,
            TransmittersFile = transmittersFile,
        });
        budget ??= UpstreamBudget.Daily(60, time);
        var env = new FakeEnv { EnvironmentName = development ? Environments.Development : Environments.Production };
        return new SatNogsClient(
            new StubHttpClientFactory(handler), options, budget, env, time,
            NullLogger<SatNogsClient>.Instance);
    }

    // -- FreqSummary formatter (pure) ----------------------------------------------------------------

    [Fact]
    public void FreqSummary_formats_the_best_active_downlink_as_mhz_plus_mode()
    {
        var list = new[] { Dto(145_800_000, "FM", "active", alive: true) };

        Assert.Equal("145.800 MHz FM", SatNogsClient.FreqSummary(list));
    }

    [Fact]
    public void FreqSummary_omits_the_mode_when_absent()
    {
        var list = new[] { Dto(437_505_000, mode: null, "active", alive: true) };

        Assert.Equal("437.505 MHz", SatNogsClient.FreqSummary(list));
    }

    [Fact]
    public void FreqSummary_excludes_inactive_and_dead_transmitters()
    {
        var inactive = new[]
        {
            Dto(145_960_000, "FM", "inactive", alive: false),
            Dto(145_970_000, "FM", "active", alive: false),   // alive=false disqualifies
            Dto(145_980_000, "FM", "invalid", alive: true),   // status != active disqualifies
        };

        Assert.Null(SatNogsClient.FreqSummary(inactive));
    }

    [Fact]
    public void FreqSummary_ignores_active_transmitters_without_a_downlink()
    {
        var noDownlink = new[] { Dto(downlinkLow: null, "FM", "active", alive: true) };

        Assert.Null(SatNogsClient.FreqSummary(noDownlink));
    }

    [Fact]
    public void FreqSummary_prefers_a_transmitter_over_a_transponder()
    {
        // First active is a Transponder; a later Transmitter should win the summary.
        var list = new[]
        {
            Dto(145_900_000, "SSB", "active", alive: true, type: "Transponder"),
            Dto(435_100_000, "CW", "active", alive: true, type: "Transmitter"),
        };

        Assert.Equal("435.100 MHz CW", SatNogsClient.FreqSummary(list));
    }

    // -- Lazy bulk load ------------------------------------------------------------------------------

    [Fact]
    public async Task GetAsync_does_not_fetch_until_the_first_call()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { Body = ArrayJson(Tx(25544, "active", true, 145_800_000, "FM")) };
        var client = CreateClient(handler, time);

        Assert.Equal(0, handler.TotalCalls); // construction alone triggers no I/O

        await client.GetAsync(TestContext.Current.CancellationToken);

        Assert.Equal(1, handler.TotalCalls);
    }

    [Fact]
    public async Task GetAsync_keys_the_dictionary_by_norad_and_skips_null_norad_rows()
    {
        var time = new FakeTimeProvider(T0);
        var budget = UpstreamBudget.Daily(60, time);
        var handler = new StubHandler
        {
            Body = ArrayJson(
                Tx(25544, "active", true, 145_825_000, "AFSK", type: "Transceiver"),
                Tx(25544, "active", true, 437_800_000, "FM"),
                Tx(null, "active", true, 100_000_000, "FM")), // null NORAD → skipped
        };
        var client = CreateClient(handler, time, budget);

        var map = await client.GetAsync(TestContext.Current.CancellationToken);

        Assert.Single(map);                               // only NORAD 25544 survives
        Assert.True(map.ContainsKey(25544));
        Assert.Equal(2, map[25544].Count);                // both of its transmitters retained
        Assert.Equal(1, budget.Used);                     // one page = one budget unit
        Assert.Equal("145.825 MHz AFSK", client.FreqSummary(25544)); // best active downlink for the sat
    }

    [Fact]
    public async Task GetAsync_serves_the_cached_map_within_the_ttl_without_refetching()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { Body = ArrayJson(Tx(25544, "active", true, 145_800_000, "FM")) };
        var client = CreateClient(handler, time);

        var first = await client.GetAsync(TestContext.Current.CancellationToken);
        time.Advance(TimeSpan.FromHours(23)); // within the 24 h TTL
        var second = await client.GetAsync(TestContext.Current.CancellationToken);

        Assert.Same(first, second);
        Assert.Equal(1, handler.TotalCalls);
    }

    // -- Stale-ok on a failed refresh ----------------------------------------------------------------

    [Fact]
    public async Task GetAsync_keeps_the_stale_map_when_a_refresh_fails()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { Body = ArrayJson(Tx(25544, "active", true, 145_800_000, "FM")) };
        var client = CreateClient(handler, time);

        var first = await client.GetAsync(TestContext.Current.CancellationToken);
        Assert.Single(first);

        // Past the TTL, SatNOGS is down: the refresh fails but the previous map is served unchanged.
        time.Advance(TimeSpan.FromHours(24) + TimeSpan.FromMinutes(1));
        handler.Status = HttpStatusCode.BadGateway;
        var stale = await client.GetAsync(TestContext.Current.CancellationToken);

        Assert.Same(first, stale);
        Assert.Equal("satnogs-unavailable", client.LastReason);
        Assert.Equal(2, handler.TotalCalls); // it did attempt the refresh
    }

    // -- Development-gated fixture -------------------------------------------------------------------

    [Fact]
    public async Task GetAsync_loads_the_transmitters_fixture_without_network_in_development()
    {
        var time = new FakeTimeProvider(T0);
        var budget = UpstreamBudget.Daily(60, time);
        var handler = new StubHandler { Status = HttpStatusCode.InternalServerError }; // would fail if touched
        var fixture = Path.Combine(AppContext.BaseDirectory, "fixtures", "transmitters.json");
        var client = CreateClient(handler, time, budget, transmittersFile: fixture, development: true);

        var map = await client.GetAsync(TestContext.Current.CancellationToken);

        Assert.Equal(0, handler.TotalCalls); // fixture load never hits the network
        Assert.Equal(0, budget.Used);
        Assert.True(map.ContainsKey(25544));                 // ISS transmitters present
        Assert.NotNull(client.FreqSummary(25544));           // ISS has an active downlink
        Assert.Null(client.FreqSummary(40967));              // AO-85: all transmitters inactive
    }

    [Fact]
    public async Task GetAsync_ignores_the_fixture_outside_development()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { Body = ArrayJson(Tx(25544, "active", true, 145_800_000, "FM")) };
        var fixture = Path.Combine(AppContext.BaseDirectory, "fixtures", "transmitters.json");
        var client = CreateClient(handler, time, transmittersFile: fixture, development: false);

        var map = await client.GetAsync(TestContext.Current.CancellationToken);

        Assert.Equal(1, handler.TotalCalls); // fixture ignored → real fetch
        Assert.Single(map);                  // the network's single record, not the fixture's many
    }

    /// <summary>Serves one canned transmitters body and counts calls; <see cref="Status" /> flips it to a non-200.</summary>
    private sealed class StubHandler : HttpMessageHandler
    {
        private int _totalCalls;

        public string Body { get; init; } = "[]";
        public HttpStatusCode Status { get; set; } = HttpStatusCode.OK;

        public int TotalCalls => Volatile.Read(ref _totalCalls);

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Interlocked.Increment(ref _totalCalls);
            return Task.FromResult(new HttpResponseMessage(Status)
            {
                Content = new StringContent(Body, Encoding.UTF8, "application/json"),
            });
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
