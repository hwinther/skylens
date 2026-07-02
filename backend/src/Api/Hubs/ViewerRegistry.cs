using System.Collections.Concurrent;

namespace Skylens.Api.Hubs;

/// <summary>Per-connection viewer subscription: where they're looking and how wide.</summary>
public sealed class ViewerSubscription
{
    public required string ConnectionId { get; init; }
    public double Lat { get; set; }
    public double Lon { get; set; }
    public double RadiusKm { get; set; }

    /// <summary>Last time this connection was allowed to (re)subscribe (server-side throttle basis).</summary>
    public DateTimeOffset LastSubscribeAt { get; set; }

    /// <summary>Set once the viewer has issued a valid Subscribe; only then do we broadcast to them.</summary>
    public bool Active { get; set; }
}

/// <summary>
///     Tracks the live hub connections and their chosen viewer location/radius so the
///     <see cref="Broadcast.SnapshotBroadcaster" /> can push each connection a filtered slim snapshot.
/// </summary>
public sealed class ViewerRegistry
{
    private readonly ConcurrentDictionary<string, ViewerSubscription> _viewers = new(StringComparer.Ordinal);

    public ViewerSubscription Add(string connectionId)
    {
        var sub = new ViewerSubscription { ConnectionId = connectionId };
        _viewers[connectionId] = sub;
        return sub;
    }

    public void Remove(string connectionId) => _viewers.TryRemove(connectionId, out _);

    public bool TryGet(string connectionId, out ViewerSubscription? sub)
    {
        var ok = _viewers.TryGetValue(connectionId, out var s);
        sub = s;
        return ok;
    }

    public IReadOnlyList<ViewerSubscription> ActiveViewers() =>
        _viewers.Values.Where(static v => v.Active).ToArray();

    public int Count => _viewers.Count;
}
