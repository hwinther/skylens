using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;
using Skylens.Api.Hubs;
using Skylens.Api.Options;
using Skylens.Api.State;

namespace Skylens.Api.Broadcast;

/// <summary>
///     0.2 Hz push loop for the AIS vertical: for every active hub viewer, build a slim list filtered to
///     positioned vessels within their radius (nearest <see cref="MaxVessels" />) and send it as a
///     <c>vessels</c> message on their connection. When a viewer is farther than <c>Feed:RadiusKm</c> from
///     the feed, or the feed has no positioned vessels in their radius, it falls back to an
///     <see cref="IVesselAwayModeSource" /> (a no-op — empty list — until Phase 5 wires BarentsWatch).
///     Runs on the aircraft hub but only ever emits <c>vessels</c>; the aircraft <c>snapshot</c>/<c>status</c>
///     frames stay owned by <see cref="SnapshotBroadcaster" />. Slower than the 1 Hz aircraft loop because
///     AIS positions move slowly and report far less often.
/// </summary>
public sealed class VesselBroadcaster : BackgroundService
{
    /// <summary>Cap on vessels pushed to one viewer per tick (nearest-first), to bound cellular payloads.</summary>
    public const int MaxVessels = 300;

    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(5);

    private readonly IHubContext<AircraftHub> _hub;
    private readonly ViewerRegistry _registry;
    private readonly VesselStateStore _store;
    private readonly IVesselAwayModeSource _awayMode;
    private readonly FeedOptions _feed;
    private readonly TimeProvider _time;
    private readonly ILogger<VesselBroadcaster> _logger;

    public VesselBroadcaster(
        IHubContext<AircraftHub> hub,
        ViewerRegistry registry,
        VesselStateStore store,
        IVesselAwayModeSource awayMode,
        IOptions<FeedOptions> feed,
        TimeProvider time,
        ILogger<VesselBroadcaster> logger)
    {
        _hub = hub;
        _registry = registry;
        _store = store;
        _awayMode = awayMode;
        _feed = feed.Value;
        _time = time;
        _logger = logger;
    }

    /// <summary>
    ///     Filter store vessels to positioned ones inside the viewer radius, sorted nearest-first and
    ///     capped at <see cref="MaxVessels" /> (own-feed / "ais"). Mirrors
    ///     <see cref="SnapshotBroadcaster.FilterOwnFeed" />, adding the distance sort + cap AIS needs.
    /// </summary>
    public static List<VesselDto> FilterOwnFeed(
        IReadOnlyList<VesselState> all, double lat, double lon, double radiusKm, DateTimeOffset nowUtc)
    {
        var within = new List<(double DistKm, VesselState State)>();
        foreach (var v in all)
        {
            if (!v.HasPosition)
                continue;
            var dist = Geo.DistanceKm(lat, lon, v.Lat!.Value, v.Lon!.Value);
            if (dist <= radiusKm)
                within.Add((dist, v));
        }

        within.Sort(static (a, b) => a.DistKm.CompareTo(b.DistKm));

        var count = Math.Min(within.Count, MaxVessels);
        var result = new List<VesselDto>(count);
        for (var i = 0; i < count; i++)
            result.Add(VesselDto.FromState(within[i].State, nowUtc));

        return result;
    }

    /// <summary>True when a viewer at (lat,lon) should be served away-mode data.</summary>
    public bool ShouldUseAwayMode(double lat, double lon, int ownFeedMatches)
    {
        var farFromFeed = Geo.DistanceKm(_feed.Lat, _feed.Lon, lat, lon) > _feed.RadiusKm;
        return farFromFeed || ownFeedMatches == 0;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval, _time);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
                await TickAsync(stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // shutting down
        }
    }

    internal async Task TickAsync(CancellationToken ct)
    {
        var viewers = _registry.ActiveViewers();
        if (viewers.Count == 0)
            return;

        var now = _time.GetUtcNow();
        var all = _store.Snapshot();
        foreach (var v in viewers)
        {
            try
            {
                var own = FilterOwnFeed(all, v.Lat, v.Lon, v.RadiusKm, now);
                if (ShouldUseAwayMode(v.Lat, v.Lon, own.Count))
                {
                    // Vessels have no "status" channel (that belongs to the aircraft hub); an away-mode
                    // reason (e.g. Phase 5 budget exhaustion) just yields its — empty — list, which we
                    // still send so the client clears any stale ships.
                    var away = await _awayMode.GetAsync(v.Lat, v.Lon, v.RadiusKm, ct);
                    await _hub.Clients.Client(v.ConnectionId).SendAsync("vessels", away.Vessels, ct);
                }
                else
                {
                    await _hub.Clients.Client(v.ConnectionId).SendAsync("vessels", own, ct);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogDebug(ex, "Vessel broadcast to {ConnectionId} failed", v.ConnectionId);
            }
        }
    }
}
