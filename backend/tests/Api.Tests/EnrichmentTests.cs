using Xunit;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Time.Testing;
using Skylens.Api.Enrichment;

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
}
