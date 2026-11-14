using Xunit;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Time.Testing;
using Skylens.Api.Enrichment;
using Skylens.Api.State;

namespace Skylens.Api.Tests;

public sealed class EnrichmentCacheTests
{
    private sealed record Box(int Value);

    [Fact]
    public async Task GetOrCreateAsync_runs_factory_once_under_concurrency()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var cache = new EnrichmentCache(memory);

        var calls = 0;
        var gate = new TaskCompletionSource();

        async Task<Box?> Factory(CancellationToken ct)
        {
            Interlocked.Increment(ref calls);
            await gate.Task; // hold all callers inside the single-flight until released
            return new Box(7);
        }

        var tasks = Enumerable.Range(0, 10)
                              .Select(_ => cache.GetOrCreateAsync("key", TimeSpan.FromMinutes(5), Factory,
                                                                  TestContext.Current.CancellationToken))
                              .ToArray();

        // Give the 10 tasks a moment to converge on the semaphore, then release.
        await Task.Delay(50, TestContext.Current.CancellationToken);
        gate.SetResult();

        var results = await Task.WhenAll(tasks);

        Assert.Equal(1, calls);
        Assert.All(results, r => Assert.Equal(7, r!.Value));
    }

    [Fact]
    public async Task GetOrCreateAsync_does_not_cache_null_results()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var cache = new EnrichmentCache(memory);
        var calls = 0;

        Task<Box?> Factory(CancellationToken ct)
        {
            calls++;
            return Task.FromResult<Box?>(null);
        }

        await cache.GetOrCreateAsync("k", TimeSpan.FromMinutes(5), Factory, TestContext.Current.CancellationToken);
        await cache.GetOrCreateAsync("k", TimeSpan.FromMinutes(5), Factory, TestContext.Current.CancellationToken);

        // A null (transient failure) is not cached, so the second call re-invokes the factory.
        Assert.Equal(2, calls);
    }
}

public sealed class UpstreamBudgetTests
{
    [Fact]
    public void TryConsume_fails_closed_when_limit_reached()
    {
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 6, 15, 12, 0, 0, TimeSpan.Zero));
        var budget = UpstreamBudget.Daily(3, time);

        Assert.True(budget.TryConsume());
        Assert.True(budget.TryConsume());
        Assert.True(budget.TryConsume());
        Assert.False(budget.TryConsume()); // exhausted
        Assert.Equal(0, budget.Remaining);
        Assert.Equal(3, budget.Used);
    }

    [Fact]
    public void Daily_budget_rolls_over_at_day_boundary()
    {
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 6, 15, 23, 59, 0, TimeSpan.Zero));
        var budget = UpstreamBudget.Daily(1, time);

        Assert.True(budget.TryConsume());
        Assert.False(budget.TryConsume());

        time.Advance(TimeSpan.FromMinutes(2)); // crosses midnight into the next day

        Assert.True(budget.TryConsume());
    }

    [Fact]
    public void Monthly_budget_rolls_over_at_month_boundary()
    {
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 6, 30, 23, 0, 0, TimeSpan.Zero));
        var budget = UpstreamBudget.Monthly(1, time);

        Assert.True(budget.TryConsume());
        Assert.False(budget.TryConsume());

        time.Advance(TimeSpan.FromHours(2)); // into July

        Assert.True(budget.TryConsume());
    }
}

public sealed class AircraftDbServiceTests
{
    [Fact]
    public void ParseCsv_reads_semicolon_delimited_rows()
    {
        using var reader = new StringReader(
            "4ca7b5;EI-EBA;B738;0;BOEING 737-800;;;\n" +
            "471f8d;LN-WEA;DH8D;0;DE HAVILLAND DASH 8;;;\n");

        var map = AircraftDbService.ParseCsv(reader);

        Assert.Equal(2, map.Count);
        Assert.Equal("EI-EBA", map["4ca7b5"].Registration);
        Assert.Equal("B738", map["4ca7b5"].TypeCode);
        Assert.Equal("BOEING 737-800", map["4ca7b5"].TypeName);
        Assert.Equal("db", map["4ca7b5"].Source);
    }

    [Fact]
    public void ParseCsv_reads_the_military_bit_of_dbFlags()
    {
        // tar1090-db writes dbFlags as 0/1 characters: military, interesting, PIA, LADD.
        using var reader = new StringReader(
            """
            4b7f4a;LX-N90442;E3TF;10;BOEING E-3A SENTRY;;;
            3c6654;D-AIRY;A321;00;AIRBUS A-321;;;
            abc123;N1;GLF5;0010;GULFSTREAM 5;;;
            def456;N2;C172;;CESSNA 172;;;
            """);

        var map = AircraftDbService.ParseCsv(reader);

        Assert.True(map["4b7f4a"].Military);
        Assert.False(map["3c6654"].Military);
        Assert.False(map["abc123"].Military); // PIA, not military
        Assert.False(map["def456"].Military); // blank flags
    }

    [Fact]
    public void Dto_omits_mil_unless_military_and_the_broadcast_filter_sets_it()
    {
        var states = new[]
        {
            new AircraftState { Hex = "4b7f4a", Lat = 59.9, Lon = 10.7 },
            new AircraftState { Hex = "3c6654", Lat = 59.9, Lon = 10.8 },
        };
        var dtos = Skylens.Api.Broadcast.SnapshotBroadcaster.FilterOwnFeed(
            states, 59.9, 10.75, 50, hex => hex == "4b7f4a");

        Assert.True(dtos.Single(d => d.Hex == "4b7f4a").Mil);
        Assert.Null(dtos.Single(d => d.Hex == "3c6654").Mil);

        var json = System.Text.Json.JsonSerializer.Serialize(dtos, new System.Text.Json.JsonSerializerOptions
        {
            PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
        });
        // Exactly one "mil" in the payload: civil aircraft don't pay a byte for the new field.
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(json, "\"mil\":"));
        Assert.Contains("\"mil\":true", json);
        // Away-mode DTOs serialize the same way (the attribute is on the record, not the mapper).
    }

    [Fact]
    public void TypeCode_reads_the_offline_registry_and_misses_cleanly()
    {
        var db = new AircraftDbService(
            Microsoft.Extensions.Options.Options.Create(new Skylens.Api.Options.AircraftDbOptions()),
            new Microsoft.Extensions.Hosting.Internal.HostingEnvironment { ContentRootPath = Path.GetTempPath() },
            Microsoft.Extensions.Logging.Abstractions.NullLogger<AircraftDbService>.Instance);
        var path = Path.Combine(Path.GetTempPath(), $"skylens-acdb-{Guid.NewGuid():N}.csv.gz");
        try
        {
            using (var gz = new System.IO.Compression.GZipStream(File.Create(path), System.IO.Compression.CompressionLevel.Fastest))
            using (var w = new StreamWriter(gz))
                w.Write("4ca7b5;EI-EBA;B738;0;BOEING 737-800;;;\n478a01;LN-OOI;EC35;0;;;;\n");
            db.Load(path);

            Assert.Equal("B738", db.TypeCode("4CA7B5")); // hex is case-insensitive
            Assert.Equal("EC35", db.TypeCode("478a01"));
            Assert.Null(db.TypeCode("000000"));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Dto_carries_t_only_when_the_type_is_known()
    {
        var states = new[]
        {
            new AircraftState { Hex = "4ca7b5", Lat = 59.9, Lon = 10.7 },
            new AircraftState { Hex = "000000", Lat = 59.9, Lon = 10.8 },
        };
        var dtos = Skylens.Api.Broadcast.SnapshotBroadcaster.FilterOwnFeed(
            states, 59.9, 10.75, 50, typeOf: hex => hex == "4ca7b5" ? "B738" : null);

        Assert.Equal("B738", dtos.Single(d => d.Hex == "4ca7b5").Type);
        Assert.Null(dtos.Single(d => d.Hex == "000000").Type);

        var json = System.Text.Json.JsonSerializer.Serialize(dtos, new System.Text.Json.JsonSerializerOptions
        {
            PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
        });
        // The short wire name, and only for the aircraft whose type is known.
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(json, "\"t\":"));
        Assert.Contains("\"t\":\"B738\"", json);
    }

    [Fact]
    public void WithTypeCodes_fills_only_missing_away_types()
    {
        IReadOnlyList<AircraftDto> away =
        [
            new() { Hex = "aaa001", Type = "A320", Src = "adsblol" },
            new() { Hex = "aaa002", Src = "adsblol" },
            new() { Hex = "aaa003", Src = "adsblol" },
        ];

        var filled = Skylens.Api.Broadcast.SnapshotBroadcaster.WithTypeCodes(
            away, hex => hex switch { "aaa001" => "B738", "aaa002" => "EC35", _ => null });

        Assert.Equal("A320", filled[0].Type); // the aggregator's own value wins
        Assert.Equal("EC35", filled[1].Type); // gap filled from the registry
        Assert.Null(filled[2].Type);
        Assert.Null(away[1].Type); // the cached list is not mutated

        // Nothing to fill: the same list comes back (no copy).
        Assert.Same(away, Skylens.Api.Broadcast.SnapshotBroadcaster.WithTypeCodes(away, _ => null));
    }
}
