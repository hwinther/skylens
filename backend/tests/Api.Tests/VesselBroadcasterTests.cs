using Xunit;
using Skylens.Api.Broadcast;
using Skylens.Api.Ingest;
using Skylens.Api.State;

namespace Skylens.Api.Tests;

/// <summary>
///     Exercises <see cref="VesselBroadcaster.FilterOwnFeed" /> directly — the geo-filter + nearest-first
///     sort + cap that decides which vessels each viewer sees. (Like <see cref="Broadcast.SnapshotBroadcaster" />,
///     the tick loop itself isn't unit-tested; the filter is the meaningful seam.)
/// </summary>
public sealed class VesselBroadcasterTests
{
    private static readonly DateTimeOffset Now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private static VesselState PositionedShip(string mmsi, double lat, double lon) => new()
    {
        Mmsi = mmsi,
        Kind = VesselKind.Ship,
        Lat = lat,
        Lon = lon,
        LastSeenUtc = Now,
    };

    [Fact]
    public void FilterOwnFeed_keeps_only_positioned_vessels_within_the_radius()
    {
        var all = new List<VesselState>
        {
            PositionedShip("near", 59.90, 10.70),        // ~0 km from centre
            PositionedShip("far", 61.00, 10.70),         // ~122 km from centre
            new() { Mmsi = "unpositioned", Kind = VesselKind.Ship, LastSeenUtc = Now }, // no lat/lon
        };

        var result = VesselBroadcaster.FilterOwnFeed(all, 59.90, 10.70, radiusKm: 50, Now);

        Assert.Single(result);
        Assert.Equal("near", result[0].Mmsi);
    }

    [Fact]
    public void FilterOwnFeed_skips_vessels_without_a_position()
    {
        var all = new List<VesselState>
        {
            new() { Mmsi = "aton-no-pos", Kind = VesselKind.Aton, AtonName = "X", LastSeenUtc = Now },
        };

        var result = VesselBroadcaster.FilterOwnFeed(all, 59.90, 10.70, radiusKm: 500, Now);

        Assert.Empty(result);
    }

    [Fact]
    public void FilterOwnFeed_caps_at_the_nearest_max_sorted_by_distance()
    {
        // MaxVessels + 50 ships strung out along a meridian, increasing distance with the index. All sit
        // inside the radius, so only the cap trims them — and it must keep the nearest ones, nearest-first.
        var all = new List<VesselState>();
        for (var i = 0; i < VesselBroadcaster.MaxVessels + 50; i++)
            all.Add(PositionedShip(i.ToString(), 59.0 + (i * 0.01), 10.0));

        var result = VesselBroadcaster.FilterOwnFeed(all, 59.0, 10.0, radiusKm: 500, Now);

        Assert.Equal(VesselBroadcaster.MaxVessels, result.Count);
        Assert.Equal("0", result[0].Mmsi);                                    // nearest first
        Assert.Equal((VesselBroadcaster.MaxVessels - 1).ToString(), result[^1].Mmsi);
        Assert.DoesNotContain(result, v => v.Mmsi == VesselBroadcaster.MaxVessels.ToString()); // farthest trimmed
    }

    [Fact]
    public void FilterOwnFeed_maps_state_to_the_slim_dto()
    {
        var ship = PositionedShip("257249000", 59.90, 10.70);
        ship.Sog = 9.9;
        ship.ShipName = "DRONNINGEN";

        var result = VesselBroadcaster.FilterOwnFeed([ship], 59.90, 10.70, radiusKm: 50, Now);

        var dto = Assert.Single(result);
        Assert.Equal("257249000", dto.Mmsi);
        Assert.Equal("ship", dto.Kind);
        Assert.Equal("DRONNINGEN", dto.Name);
        Assert.Equal(9.9, dto.Sog);
        Assert.Equal(0, dto.Seen); // LastSeenUtc == Now
    }
}
