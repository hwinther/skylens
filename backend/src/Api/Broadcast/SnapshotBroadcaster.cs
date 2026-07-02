using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;
using Skylens.Api.Hubs;
using Skylens.Api.Options;
using Skylens.Api.State;

namespace Skylens.Api.Broadcast;

/// <summary>
///     1 Hz push loop: for every active hub viewer, build a slim snapshot filtered to positioned
///     aircraft within their radius and send it on their connection. When a viewer is farther than
///     <c>Feed:RadiusKm</c> from the feed, or the feed has no positioned aircraft in their radius,
///     it falls back to an ADSBx-sourced ("adsbx") snapshot; if the away-mode budget is exhausted it
///     sends a status frame with the reason instead.
/// </summary>
public sealed class SnapshotBroadcaster : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(1);

    private readonly IHubContext<AircraftHub> _hub;
    private readonly ViewerRegistry _registry;
    private readonly AircraftStateStore _store;
    private readonly IAwayModeSource _awayMode;
    private readonly FeedOptions _feed;
    private readonly TimeProvider _time;
    private readonly ILogger<SnapshotBroadcaster> _logger;

    public SnapshotBroadcaster(
        IHubContext<AircraftHub> hub,
        ViewerRegistry registry,
        AircraftStateStore store,
        IAwayModeSource awayMode,
        IOptions<FeedOptions> feed,
        TimeProvider time,
        ILogger<SnapshotBroadcaster> logger)
    {
        _hub = hub;
        _registry = registry;
        _store = store;
        _awayMode = awayMode;
        _feed = feed.Value;
        _time = time;
        _logger = logger;
    }

    /// <summary>Filter store aircraft to positioned ones inside the viewer radius (own-feed / "adsb").</summary>
    public static List<AircraftDto> FilterOwnFeed(IReadOnlyList<AircraftState> all, double lat, double lon, double radiusKm)
    {
        var result = new List<AircraftDto>();
        foreach (var a in all)
        {
            if (!a.HasPosition)
                continue;
            if (Geo.DistanceKm(lat, lon, a.Lat!.Value, a.Lon!.Value) <= radiusKm)
                result.Add(AircraftDto.FromState(a, "adsb"));
        }

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

        var all = _store.Snapshot();
        foreach (var v in viewers)
        {
            try
            {
                var own = FilterOwnFeed(all, v.Lat, v.Lon, v.RadiusKm);
                if (ShouldUseAwayMode(v.Lat, v.Lon, own.Count))
                {
                    var away = await _awayMode.GetAsync(v.Lat, v.Lon, v.RadiusKm, ct);
                    if (away.StatusReason is not null)
                    {
                        await _hub.Clients.Client(v.ConnectionId)
                                  .SendAsync("status", new { reason = away.StatusReason }, ct);
                        continue;
                    }

                    await _hub.Clients.Client(v.ConnectionId).SendAsync("snapshot", away.Aircraft, ct);
                }
                else
                {
                    await _hub.Clients.Client(v.ConnectionId).SendAsync("snapshot", own, ct);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogDebug(ex, "Broadcast to {ConnectionId} failed", v.ConnectionId);
            }
        }
    }
}
