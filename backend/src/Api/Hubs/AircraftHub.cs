using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace Skylens.Api.Hubs;

/// <summary>
///     Real-time aircraft feed hub at <c>/hubs/aircraft</c>. Clients call
///     <see cref="Subscribe" /> with their viewer location + radius; the
///     <see cref="Broadcast.SnapshotBroadcaster" /> then pushes a filtered slim snapshot 1 Hz.
///     Subscribe is throttled to 1 per 10 s per connection.
/// </summary>
[Authorize]
public sealed class AircraftHub : Hub
{
    /// <summary>Minimum interval between honored Subscribe calls on a single connection.</summary>
    public static readonly TimeSpan SubscribeThrottle = TimeSpan.FromSeconds(10);

    private readonly ViewerRegistry _registry;
    private readonly TimeProvider _time;
    private readonly ILogger<AircraftHub> _logger;

    public AircraftHub(ViewerRegistry registry, TimeProvider time, ILogger<AircraftHub> logger)
    {
        _registry = registry;
        _time = time;
        _logger = logger;
    }

    public override Task OnConnectedAsync()
    {
        _registry.Add(Context.ConnectionId);
        using (BeginAuditScope("hub-connect"))
            _logger.LogInformation("Hub connected {ConnectionId}", Context.ConnectionId);
        return base.OnConnectedAsync();
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        _registry.Remove(Context.ConnectionId);
        _logger.LogInformation("Hub disconnected {ConnectionId}", Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }

    /// <summary>
    ///     Set (or update) the caller's viewer location and radius. Returns true if honored,
    ///     false if throttled. Remembered per connection for subsequent broadcasts.
    /// </summary>
    public Task<bool> Subscribe(double lat, double lon, double radiusKm)
    {
        if (!_registry.TryGet(Context.ConnectionId, out var sub) || sub is null)
        {
            sub = _registry.Add(Context.ConnectionId);
        }

        var now = _time.GetUtcNow();
        if (sub.Active && now - sub.LastSubscribeAt < SubscribeThrottle)
            return Task.FromResult(false);

        sub.Lat = lat;
        sub.Lon = lon;
        sub.RadiusKm = Math.Clamp(radiusKm, 1, 500);
        sub.LastSubscribeAt = now;
        sub.Active = true;

        using (BeginAuditScope("hub-subscribe"))
            _logger.LogInformation(
                "Hub subscribe {ConnectionId} lat={Lat} lon={Lon} radiusKm={RadiusKm}",
                Context.ConnectionId, lat, lon, sub.RadiusKm);

        return Task.FromResult(true);
    }

    private IDisposable? BeginAuditScope(string action) =>
        _logger.BeginScope(new Dictionary<string, object?>
        {
            ["action"] = action,
            ["sub"] = Context.User?.FindFirst("sub")?.Value
                      ?? Context.UserIdentifier,
            ["preferred_username"] = Context.User?.FindFirst("preferred_username")?.Value,
            ["connectionId"] = Context.ConnectionId,
        });
}
