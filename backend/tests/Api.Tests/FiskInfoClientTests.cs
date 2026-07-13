using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Skylens.Api.Endpoints;
using Skylens.Api.Enrichment;
using Skylens.Api.Options;

namespace Skylens.Api.Tests;

/// <summary>
///     Exercises <see cref="FiskInfoClient" /> against a stubbed <see cref="HttpMessageHandler" /> and a
///     <see cref="FakeTimeProvider" />: OAuth token caching/single-flight, per-dataset budget fail-closed,
///     zone normalization (cod + forbidden + zero merged with the right <c>kind</c> and geometry passed
///     through VERBATIM), partial-failure resilience, lost-gear mapping, and ship-register lookup + 204/404
///     handling. The <c>/api/vessels/{mmsi}</c> ship-register fold is covered via
///     <see cref="ApiEndpoints.ApplyShipRegister" /> directly.
/// </summary>
public sealed class FiskInfoClientTests
{
    private static readonly DateTimeOffset T0 = new(2026, 7, 12, 12, 0, 0, TimeSpan.Zero);

    private const string TokenJson = """{"access_token":"tok-abc","token_type":"Bearer","expires_in":3600}""";

    private const string ForbiddenGeometry =
        """{"type":"Polygon","coordinates":[[[10.4,60.5],[10.5,60.5],[10.5,60.6],[10.4,60.5]]]}""";
    private const string ZeroGeometry =
        """{"type":"MultiPolygon","coordinates":[[[[5.0,62.0],[5.1,62.0],[5.1,62.1],[5.0,62.0]]]]}""";
    private const string CodGeometry =
        """{"type":"LineString","coordinates":[[18.0,69.0],[18.1,69.1]]}""";
    private const string LostGeometry = """{"type":"Point","coordinates":[17.5,69.5]}""";

    // Built by compile-time const concatenation (raw interpolation would collide with the JSON's own {{ }}).
    private const string ForbiddenJson =
        """[{"geometry":""" + ForbiddenGeometry + ""","objectId":1,"info":"No trawling"}]""";
    private const string ZeroJson =
        """[{"geometry":""" + ZeroGeometry + ""","objectId":2,"name":"Zero Area A","info":"seasonal","url":"http://x"}]""";
    private const string CodJson =
        """{"type":"FeatureCollection","features":[{"type":"Feature","geometry":""" + CodGeometry +
        ""","properties":{"area_id":42,"start_point_description":"Cape A","end_point_description":"Cape B"}}]}""";
    private const string LostGearJson =
        """[{"lostMessageId":"11111111-1111-1111-1111-111111111111","toolTypeCode":"NET","lostCount":3,"lostTime":"2026-07-01T10:00:00+00:00","lostCause":"Weather","source":"api","vesselName":null,"mmsi":null,"geometry":""" +
        LostGeometry + """}]""";
    private const string ShipRegisterJson =
        """{"mmsi":257011940,"imo":9271819,"callSign":"LABC","regno":"N-0123-B","name":"BALDER","lengthOverall":24.5,"length":23.0,"breadth":7.0,"grossTonnage":150.0,"registered":true,"type":{"id":"FISH","descriptionEn":"Fishing vessel","descriptionNo":"Fiskefartøy"},"owner":{"orgNumber":123456789,"name":"Balder AS"}}""";

    private static FiskInfoClient CreateClient(
        StubHandler handler,
        TimeProvider time,
        UpstreamBudget? budget = null,
        bool configured = true,
        EnrichmentCache? cache = null)
    {
        var factory = new StubHttpClientFactory(handler);
        var options = Microsoft.Extensions.Options.Options.Create(new FiskInfoOptions
        {
            ClientId = configured ? "id" : null,
            ClientSecret = configured ? "secret" : null,
            TokenEndpoint = "https://id.barentswatch.test/connect/token",
            Scope = "api",
            BaseUrl = "https://www.barentswatch.test/bwapi",
            DailyBudget = 500,
        });
        cache ??= new EnrichmentCache(new MemoryCache(new MemoryCacheOptions()));
        budget ??= UpstreamBudget.Daily(500, time);
        return new FiskInfoClient(factory, options, cache, budget, time, NullLogger<FiskInfoClient>.Instance);
    }

    // -- Fail-closed paths ---------------------------------------------------------------------------

    [Fact]
    public async Task GetZonesAsync_unconfigured_returns_null_with_reason_and_no_http()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler();
        var client = CreateClient(handler, time, configured: false);

        var result = await client.GetZonesAsync(TestContext.Current.CancellationToken);

        Assert.Null(result);
        Assert.Equal("fiskinfo-unconfigured", client.LastReason);
        Assert.Equal(0, handler.TotalCalls);
    }

    [Fact]
    public async Task GetLostGearAsync_unconfigured_returns_null_with_no_http()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler();
        var client = CreateClient(handler, time, configured: false);

        var result = await client.GetLostGearAsync(TestContext.Current.CancellationToken);

        Assert.Null(result);
        Assert.Equal(0, handler.TotalCalls);
    }

    [Fact]
    public async Task LookupShipRegisterAsync_unconfigured_returns_null_with_no_http()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler();
        var client = CreateClient(handler, time, configured: false);

        var result = await client.LookupShipRegisterAsync("257011940", TestContext.Current.CancellationToken);

        Assert.Null(result);
        Assert.Equal(0, handler.TotalCalls);
    }

    [Fact]
    public async Task GetZonesAsync_budget_exhausted_fails_closed_after_the_token()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler();
        var client = CreateClient(handler, time, budget: UpstreamBudget.Daily(0, time));

        var result = await client.GetZonesAsync(TestContext.Current.CancellationToken);

        Assert.Null(result);
        Assert.Equal("fiskinfo-budget-exhausted", client.LastReason);
        Assert.Equal(1, handler.TokenCalls);   // the token itself isn't budgeted
        Assert.Equal(0, handler.CodCalls);     // every dataset fetch is blocked before any HTTP
        Assert.Equal(0, handler.ForbiddenCalls);
        Assert.Equal(0, handler.ZeroCalls);
    }

    [Fact]
    public async Task GetZonesAsync_token_failure_surfaces_reason_not_exception()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { TokenStatus = HttpStatusCode.Unauthorized };
        var client = CreateClient(handler, time);

        var result = await client.GetZonesAsync(TestContext.Current.CancellationToken);

        Assert.Null(result);
        Assert.Equal("fiskinfo-unavailable", client.LastReason);
        Assert.Equal(1, handler.TokenCalls);
        Assert.Equal(0, handler.CodCalls);
    }

    // -- Zone normalization --------------------------------------------------------------------------

    [Fact]
    public async Task GetZonesAsync_merges_all_three_datasets_with_correct_kinds_and_verbatim_geometry()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler
        {
            CodBody = CodJson, ForbiddenBody = ForbiddenJson, ZeroBody = ZeroJson,
        };
        var client = CreateClient(handler, time);

        var result = await client.GetZonesAsync(TestContext.Current.CancellationToken);

        Assert.NotNull(result);
        Assert.Null(client.LastReason);
        Assert.Equal(T0, result!.FetchedAt);
        Assert.Equal(3, result.Zones.Count);

        var cod = Assert.Single(result.Zones, z => z.Kind == "cod");
        Assert.Equal("Cape A → Cape B", cod.Info);
        AssertGeometryVerbatim(CodGeometry, cod.Geometry);

        var forbidden = Assert.Single(result.Zones, z => z.Kind == "forbidden");
        Assert.Equal("No trawling", forbidden.Info);
        AssertGeometryVerbatim(ForbiddenGeometry, forbidden.Geometry);

        var zero = Assert.Single(result.Zones, z => z.Kind == "zero");
        Assert.Equal("Zero Area A", zero.Info); // name wins over info
        AssertGeometryVerbatim(ZeroGeometry, zero.Geometry);

        // One budget unit per dataset (three total); the token isn't budgeted.
        Assert.Equal(1, handler.CodCalls);
        Assert.Equal(1, handler.ForbiddenCalls);
        Assert.Equal(1, handler.ZeroCalls);
    }

    [Fact]
    public async Task GetZonesAsync_keeps_good_datasets_when_one_fails()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler
        {
            CodBody = CodJson, ForbiddenStatus = HttpStatusCode.InternalServerError, ZeroBody = ZeroJson,
        };
        var client = CreateClient(handler, time);

        var result = await client.GetZonesAsync(TestContext.Current.CancellationToken);

        Assert.NotNull(result);
        Assert.Equal(2, result!.Zones.Count);
        Assert.Contains(result.Zones, z => z.Kind == "cod");
        Assert.Contains(result.Zones, z => z.Kind == "zero");
        Assert.DoesNotContain(result.Zones, z => z.Kind == "forbidden");
    }

    [Fact]
    public async Task GetZonesAsync_caches_within_ttl_and_runs_each_fetch_once_under_concurrency()
    {
        var time = new FakeTimeProvider(T0);
        var release = new TaskCompletionSource();
        var handler = new StubHandler
        {
            CodBody = CodJson, ForbiddenBody = ForbiddenJson, ZeroBody = ZeroJson, TokenGate = release.Task,
        };
        var client = CreateClient(handler, time);

        var tasks = Enumerable.Range(0, 10)
                              .Select(_ => client.GetZonesAsync(TestContext.Current.CancellationToken))
                              .ToArray();

        await Task.Delay(50, TestContext.Current.CancellationToken); // let the 10 converge on the cache gate
        release.SetResult();
        await Task.WhenAll(tasks);

        Assert.Equal(1, handler.TokenCalls);
        Assert.Equal(1, handler.CodCalls);
        Assert.Equal(1, handler.ForbiddenCalls);
        Assert.Equal(1, handler.ZeroCalls);

        // A later call within the 12 h TTL is served from cache — no further upstream.
        time.Advance(TimeSpan.FromHours(1));
        await client.GetZonesAsync(TestContext.Current.CancellationToken);
        Assert.Equal(1, handler.CodCalls);
    }

    // -- Lost gear -----------------------------------------------------------------------------------

    [Fact]
    public async Task GetLostGearAsync_maps_anonymized_fields_and_caches()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { LostGearBody = LostGearJson };
        var client = CreateClient(handler, time);

        var gear = await client.GetLostGearAsync(TestContext.Current.CancellationToken);

        Assert.NotNull(gear);
        var g = Assert.Single(gear!);
        Assert.Equal("NET", g.ToolTypeCode);
        Assert.Equal(3, g.Count);
        Assert.Equal(new DateTimeOffset(2026, 7, 1, 10, 0, 0, TimeSpan.Zero), g.LostTime);
        Assert.Equal("Weather", g.LostCause);
        Assert.Equal("api", g.Source);
        AssertGeometryVerbatim(LostGeometry, g.Geometry);

        // Cached within the 3 h TTL — no second upstream fetch.
        time.Advance(TimeSpan.FromHours(1));
        await client.GetLostGearAsync(TestContext.Current.CancellationToken);
        Assert.Equal(1, handler.LostGearCalls);
    }

    // -- Ship register -------------------------------------------------------------------------------

    [Fact]
    public async Task LookupShipRegisterAsync_maps_fields_and_caches_within_ttl()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { ShipRegisterBody = ShipRegisterJson };
        var client = CreateClient(handler, time);

        var reg = await client.LookupShipRegisterAsync("257011940", TestContext.Current.CancellationToken);

        Assert.NotNull(reg);
        Assert.Equal("257011940", reg!.Mmsi);
        Assert.Equal(9271819, reg.Imo);
        Assert.Equal("LABC", reg.CallSign);
        Assert.Equal("BALDER", reg.Name);
        Assert.Equal("N-0123-B", reg.RegNo);
        Assert.Equal("Fishing vessel", reg.VesselType);  // English description wins
        Assert.Equal("Balder AS", reg.Owner);
        Assert.Equal(24.5, reg.LengthOverall);            // lengthOverall preferred over length
        Assert.Equal(150.0, reg.GrossTonnage);
        Assert.True(reg.Registered);

        // A second lookup within the 7 d TTL is served from the cache — no second upstream GET.
        time.Advance(TimeSpan.FromDays(1));
        await client.LookupShipRegisterAsync("257011940", TestContext.Current.CancellationToken);
        Assert.Equal(1, handler.ShipRegisterCalls);
    }

    [Theory]
    [InlineData(HttpStatusCode.NoContent)]
    [InlineData(HttpStatusCode.NotFound)]
    public async Task LookupShipRegisterAsync_returns_null_when_not_in_register(HttpStatusCode status)
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { ShipRegisterStatus = status };
        var client = CreateClient(handler, time);

        var reg = await client.LookupShipRegisterAsync("999999999", TestContext.Current.CancellationToken);

        Assert.Null(reg);
        Assert.Equal(1, handler.ShipRegisterCalls);
    }

    [Fact]
    public async Task LookupShipRegisterAsync_budget_exhausted_returns_null_without_the_register_get()
    {
        var time = new FakeTimeProvider(T0);
        var handler = new StubHandler { ShipRegisterBody = ShipRegisterJson };
        var client = CreateClient(handler, time, budget: UpstreamBudget.Daily(0, time));

        var reg = await client.LookupShipRegisterAsync("257011940", TestContext.Current.CancellationToken);

        Assert.Null(reg);
        Assert.Equal(0, handler.ShipRegisterCalls); // fails closed before the register GET
    }

    // -- Ship-register fold into VesselMetadata (the /api/vessels/{mmsi} seam) ------------------------

    [Fact]
    public void ApplyShipRegister_folds_register_fields_and_fills_null_identity()
    {
        var metadata = new VesselMetadata { Mmsi = "257011940", CallSign = "LOCAL", Source = "ais" };
        var register = new ShipRegister(
            Mmsi: "257011940", Imo: 9271819, CallSign: "REGCS", Name: "BALDER", RegNo: "N-0123-B",
            VesselType: "Fishing vessel", Owner: "Balder AS", LengthOverall: 24.5, GrossTonnage: 150.0,
            Registered: true);

        var merged = ApiEndpoints.ApplyShipRegister(metadata, register, "257011940")!;

        Assert.Equal("LOCAL", merged.CallSign);   // AIS call sign wins
        Assert.Equal(9271819, merged.Imo);        // register fills the null IMO
        Assert.Equal("BALDER", merged.RegisterName);
        Assert.Equal("Balder AS", merged.RegisterOwner);
        Assert.Equal("Fishing vessel", merged.RegisterType);
        Assert.Equal(24.5, merged.RegisterLengthOverall);
        Assert.Equal("ais", merged.Source);       // provenance unchanged
    }

    [Fact]
    public void ApplyShipRegister_null_register_is_a_noop_and_register_only_materializes_metadata()
    {
        var metadata = new VesselMetadata { Mmsi = "1", CallSign = "LOCAL" };
        Assert.Same(metadata, ApiEndpoints.ApplyShipRegister(metadata, null, "1"));
        Assert.Null(ApiEndpoints.ApplyShipRegister(null, null, "1"));

        var register = new ShipRegister(
            Mmsi: "257011940", Imo: null, CallSign: "REGCS", Name: "BALDER", RegNo: null,
            VesselType: "Fishing vessel", Owner: "Balder AS", LengthOverall: null, GrossTonnage: null,
            Registered: true);

        var fromRegister = ApiEndpoints.ApplyShipRegister(null, register, "257011940")!;
        Assert.Equal("257011940", fromRegister.Mmsi);
        Assert.Equal("REGCS", fromRegister.CallSign); // filled the null identity
        Assert.Equal("BALDER", fromRegister.RegisterName);
    }

    private static void AssertGeometryVerbatim(string expectedJson, JsonNode? actual)
    {
        Assert.NotNull(actual);
        Assert.Equal(JsonNode.Parse(expectedJson)!.ToJsonString(), actual!.ToJsonString());
    }

    /// <summary>Returns a fresh <see cref="HttpClient" /> over the shared stub handler for every named client.</summary>
    private sealed class StubHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    /// <summary>
    ///     Routes FiskInfo's request shapes (token POST + one GET per dataset/lookup) to canned bodies and
    ///     counts each. <see cref="TokenGate" /> lets a test hold callers inside the token step to prove the
    ///     zones single-flight runs the whole factory once.
    /// </summary>
    private sealed class StubHandler : HttpMessageHandler
    {
        private int _tokenCalls;
        private int _codCalls;
        private int _forbiddenCalls;
        private int _zeroCalls;
        private int _lostGearCalls;
        private int _shipRegisterCalls;

        public HttpStatusCode TokenStatus { get; init; } = HttpStatusCode.OK;
        public HttpStatusCode ForbiddenStatus { get; init; } = HttpStatusCode.OK;
        public HttpStatusCode ShipRegisterStatus { get; init; } = HttpStatusCode.OK;

        public string CodBody { get; init; } = """{"type":"FeatureCollection","features":[]}""";
        public string ForbiddenBody { get; init; } = "[]";
        public string ZeroBody { get; init; } = "[]";
        public string LostGearBody { get; init; } = "[]";
        public string ShipRegisterBody { get; init; } = "{}";
        public Task? TokenGate { get; init; }

        public int TokenCalls => Volatile.Read(ref _tokenCalls);
        public int CodCalls => Volatile.Read(ref _codCalls);
        public int ForbiddenCalls => Volatile.Read(ref _forbiddenCalls);
        public int ZeroCalls => Volatile.Read(ref _zeroCalls);
        public int LostGearCalls => Volatile.Read(ref _lostGearCalls);
        public int ShipRegisterCalls => Volatile.Read(ref _shipRegisterCalls);

        public int TotalCalls =>
            TokenCalls + CodCalls + ForbiddenCalls + ZeroCalls + LostGearCalls + ShipRegisterCalls;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var uri = request.RequestUri!.AbsoluteUri;

            if (uri.Contains("connect/token", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref _tokenCalls);
                if (TokenGate is not null)
                    await TokenGate.WaitAsync(ct);
                return Json(TokenStatus, TokenStatus == HttpStatusCode.OK ? TokenJson : "");
            }

            if (uri.Contains("/geodata/download/coastalcodregulations", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref _codCalls);
                return Json(HttpStatusCode.OK, CodBody);
            }

            if (uri.Contains("/geodata/forbiddenfishingzone", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref _forbiddenCalls);
                return Json(ForbiddenStatus, ForbiddenStatus == HttpStatusCode.OK ? ForbiddenBody : "");
            }

            if (uri.Contains("/geodata/zerofishingarea", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref _zeroCalls);
                return Json(HttpStatusCode.OK, ZeroBody);
            }

            if (uri.Contains("/lostfishingfacility/notremoved", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref _lostGearCalls);
                return Json(HttpStatusCode.OK, LostGearBody);
            }

            if (uri.Contains("/shipregister/", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref _shipRegisterCalls);
                return ShipRegisterStatus == HttpStatusCode.OK
                    ? Json(HttpStatusCode.OK, ShipRegisterBody)
                    : new HttpResponseMessage(ShipRegisterStatus);
            }

            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }

        private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
    }
}
