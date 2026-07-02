using Xunit;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Skylens.Api.Ingest;
using Skylens.Api.State;

namespace Skylens.Api.Tests;

public sealed class AircraftStateStoreTests
{
    private static AircraftUpdate Update(string hex, double? lat = null, double? lon = null) =>
        new() { Hex = hex, Lat = lat, Lon = lon };

    [Fact]
    public void ApplyUpdates_merges_non_null_fields_across_snapshots()
    {
        var time = new FakeTimeProvider();
        var store = new AircraftStateStore(time, NullLogger<AircraftStateStore>.Instance);

        store.ApplyUpdates([new AircraftUpdate { Hex = "abc123", Flight = "SAS1", Lat = 59.9, Lon = 10.7 }]);
        // A later snapshot with only a track update must not blank the position.
        store.ApplyUpdates([new AircraftUpdate { Hex = "abc123", Track = 90 }]);

        Assert.True(store.TryGet("abc123", out var state));
        Assert.Equal("SAS1", state!.Flight);
        Assert.Equal(59.9, state.Lat);
        Assert.Equal(90, state.Track);
    }

    [Fact]
    public void Evict_removes_entries_older_than_ttl()
    {
        var start = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(start);
        var store = new AircraftStateStore(time, NullLogger<AircraftStateStore>.Instance);

        store.ApplyUpdates([Update("old", 59.9, 10.7)]);

        // Advance past the TTL, then add a fresh one and evict.
        time.Advance(AircraftStateStore.Ttl + TimeSpan.FromSeconds(5));
        store.ApplyUpdates([Update("fresh", 60.0, 10.0)]);

        var removed = store.Evict(time.GetUtcNow());

        Assert.Equal(1, removed);
        Assert.False(store.TryGet("old", out _));
        Assert.True(store.TryGet("fresh", out _));
    }

    [Fact]
    public void Evict_keeps_entries_within_ttl()
    {
        var start = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(start);
        var store = new AircraftStateStore(time, NullLogger<AircraftStateStore>.Instance);

        store.ApplyUpdates([Update("recent", 59.9, 10.7)]);
        time.Advance(TimeSpan.FromSeconds(30)); // < 60 s TTL

        var removed = store.Evict(time.GetUtcNow());

        Assert.Equal(0, removed);
        Assert.True(store.TryGet("recent", out _));
    }

    [Fact]
    public async Task Background_timer_evicts_stale_entries()
    {
        var start = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(start);
        var store = new AircraftStateStore(time, NullLogger<AircraftStateStore>.Instance);

        await store.StartAsync(TestContext.Current.CancellationToken);
        store.ApplyUpdates([Update("stale", 59.9, 10.7)]);

        // Let ExecuteAsync reach WaitForNextTickAsync so the PeriodicTimer is registered with the
        // FakeTimeProvider before we advance; otherwise Advance sees no timer to fire.
        for (var i = 0; i < 20 && store.Count > 0; i++)
        {
            // Advance past the TTL in eviction-interval steps so each tick's continuation can run.
            time.Advance(AircraftStateStore.Ttl + TimeSpan.FromSeconds(20));
            await Task.Yield();
            await Task.Delay(5, TestContext.Current.CancellationToken);
        }

        Assert.Equal(0, store.Count);
        await store.StopAsync(TestContext.Current.CancellationToken);
    }
}
