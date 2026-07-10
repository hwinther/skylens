using Xunit;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Skylens.Api.Ingest;
using Skylens.Api.State;

namespace Skylens.Api.Tests;

public sealed class VesselStateStoreTests
{
    private static VesselUpdate Ship(string mmsi, double? lat = null, double? lon = null) =>
        new() { Mmsi = mmsi, Kind = VesselKind.Ship, Lat = lat, Lon = lon };

    [Fact]
    public void ApplyUpdate_merges_position_and_static_reports_across_messages()
    {
        var time = new FakeTimeProvider();
        var store = new VesselStateStore(time, NullLogger<VesselStateStore>.Instance);

        // A Class B position report, then a Class A/B static report for the same MMSI.
        store.ApplyUpdate(new VesselUpdate { Mmsi = "257249000", Kind = VesselKind.Ship, Lat = 59.89, Lon = 10.68, Sog = 9.9 });
        store.ApplyUpdate(new VesselUpdate { Mmsi = "257249000", Kind = VesselKind.Ship, ShipName = "DRONNINGEN", ShipType = 60, CallSign = "LCDF" });

        Assert.True(store.TryGet("257249000", out var s));
        Assert.Equal(59.89, s!.Lat); // position survived the static message
        Assert.Equal(9.9, s.Sog);
        Assert.Equal("DRONNINGEN", s.ShipName); // static merged in
        Assert.Equal(60, s.ShipType);
        Assert.Equal("LCDF", s.CallSign);
    }

    [Fact]
    public void ApplyUpdate_position_only_message_does_not_erase_static_fields()
    {
        var time = new FakeTimeProvider();
        var store = new VesselStateStore(time, NullLogger<VesselStateStore>.Instance);

        store.ApplyUpdate(new VesselUpdate { Mmsi = "257249000", Kind = VesselKind.Ship, ShipName = "DRONNINGEN", ShipType = 60 });
        // A later position-only report must not blank the name/type.
        store.ApplyUpdate(new VesselUpdate { Mmsi = "257249000", Kind = VesselKind.Ship, Lat = 59.9, Lon = 10.7 });

        Assert.True(store.TryGet("257249000", out var s));
        Assert.Equal("DRONNINGEN", s!.ShipName);
        Assert.Equal(60, s.ShipType);
        Assert.Equal(59.9, s.Lat);
    }

    [Fact]
    public void ApplyUpdate_preserves_aton_kind_and_fields()
    {
        var time = new FakeTimeProvider();
        var store = new VesselStateStore(time, NullLogger<VesselStateStore>.Instance);

        store.ApplyUpdate(new VesselUpdate
        {
            Mmsi = "992576411",
            Kind = VesselKind.Aton,
            Lat = 59.12,
            Lon = 9.6,
            AidType = 5,
            AtonName = "VIRTUAL ATON(2)",
            VirtualAid = true,
        });

        Assert.True(store.TryGet("992576411", out var s));
        Assert.Equal(VesselKind.Aton, s!.Kind);
        Assert.Equal(5, s.AidType);
        Assert.Equal("VIRTUAL ATON(2)", s.AtonName);
        Assert.True(s.VirtualAid);
    }

    [Fact]
    public void Evict_keeps_entries_within_the_15_minute_ttl()
    {
        var start = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(start);
        var store = new VesselStateStore(time, NullLogger<VesselStateStore>.Instance);

        store.ApplyUpdate(Ship("257000001", 59.9, 10.7));
        time.Advance(TimeSpan.FromMinutes(14)); // < 15 min TTL

        var removed = store.Evict(time.GetUtcNow());

        Assert.Equal(0, removed);
        Assert.True(store.TryGet("257000001", out _));
    }

    [Fact]
    public void Evict_removes_entries_older_than_the_15_minute_ttl()
    {
        var start = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(start);
        var store = new VesselStateStore(time, NullLogger<VesselStateStore>.Instance);

        store.ApplyUpdate(Ship("old", 59.9, 10.7));

        // Advance past the TTL, then add a fresh one and evict.
        time.Advance(TimeSpan.FromMinutes(16));
        store.ApplyUpdate(Ship("fresh", 60.0, 10.0));

        var removed = store.Evict(time.GetUtcNow());

        Assert.Equal(1, removed);
        Assert.False(store.TryGet("old", out _));
        Assert.True(store.TryGet("fresh", out _));
    }

    [Fact]
    public void Snapshot_returns_all_current_targets()
    {
        var time = new FakeTimeProvider();
        var store = new VesselStateStore(time, NullLogger<VesselStateStore>.Instance);

        store.ApplyUpdate(Ship("257000001", 59.9, 10.7));
        store.ApplyUpdate(new VesselUpdate { Mmsi = "992576411", Kind = VesselKind.Aton, AtonName = "X" });

        var snapshot = store.Snapshot();

        Assert.Equal(2, snapshot.Count);
        Assert.Contains(snapshot, s => s.Mmsi == "257000001");
        Assert.Contains(snapshot, s => s.Mmsi == "992576411" && s.Kind == VesselKind.Aton);
    }

    [Fact]
    public async Task Background_timer_evicts_stale_targets()
    {
        var start = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(start);
        var store = new VesselStateStore(time, NullLogger<VesselStateStore>.Instance);

        await store.StartAsync(TestContext.Current.CancellationToken);
        store.ApplyUpdate(Ship("stale", 59.9, 10.7));

        // Let ExecuteAsync reach WaitForNextTickAsync so the PeriodicTimer is registered with the
        // FakeTimeProvider before we advance; otherwise Advance sees no timer to fire.
        for (var i = 0; i < 20 && store.Count > 0; i++)
        {
            time.Advance(VesselStateStore.Ttl + TimeSpan.FromMinutes(2));
            await Task.Yield();
            await Task.Delay(5, TestContext.Current.CancellationToken);
        }

        Assert.Equal(0, store.Count);
        await store.StopAsync(TestContext.Current.CancellationToken);
    }
}
