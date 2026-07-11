using System.Collections.Concurrent;

namespace Skylens.Api.State;

/// <summary>
///     In-memory current-picture of all tracked AIS targets, keyed by MMSI. Updates merge non-null
///     fields; entries not seen for <see cref="Ttl" /> are evicted by a background
///     <see cref="PeriodicTimer" />. <see cref="TimeProvider" /> is injected so tests drive the clock.
///     Mirrors <see cref="AircraftStateStore" />; the longer 15-minute TTL reflects AIS's slower report
///     cadence (Class A static/voyage every ~6 min, some AtoN much less often) so parked or briefly
///     out-of-range targets don't flicker off the map.
/// </summary>
public sealed class VesselStateStore : BackgroundService
{
    public static readonly TimeSpan Ttl = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan EvictionInterval = TimeSpan.FromSeconds(60);

    private readonly ConcurrentDictionary<string, VesselState> _byMmsi = new(StringComparer.Ordinal);
    private readonly TimeProvider _time;
    private readonly ILogger<VesselStateStore> _logger;

    public VesselStateStore(TimeProvider time, ILogger<VesselStateStore> logger)
    {
        _time = time;
        _logger = logger;
    }

    public int Count => _byMmsi.Count;

    /// <summary>Apply one parsed AIS update, merging its non-null fields onto the target's picture.</summary>
    public void ApplyUpdate(Ingest.VesselUpdate update)
    {
        var now = _time.GetUtcNow();
        _byMmsi.AddOrUpdate(
            update.Mmsi,
            static (_, arg) => VesselState.FromUpdate(arg.update, arg.now),
            static (_, existing, arg) =>
            {
                existing.Merge(arg.update, arg.now);
                return existing;
            },
            (update, now));
    }

    public bool TryGet(string mmsi, out VesselState? state)
    {
        var ok = _byMmsi.TryGetValue(mmsi, out var s);
        state = s;
        return ok;
    }

    /// <summary>Snapshot of all current targets (a copy of the values; safe to enumerate).</summary>
    public IReadOnlyList<VesselState> Snapshot() => _byMmsi.Values.ToArray();

    /// <summary>Evict entries older than the TTL relative to <paramref name="now" />. Returns evicted count.</summary>
    internal int Evict(DateTimeOffset now)
    {
        var removed = 0;
        foreach (var kvp in _byMmsi)
        {
            if (now - kvp.Value.LastSeenUtc > Ttl && _byMmsi.TryRemove(kvp.Key, out _))
                removed++;
        }

        return removed;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(EvictionInterval, _time);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                var removed = Evict(_time.GetUtcNow());
                if (removed > 0)
                    _logger.LogDebug("Evicted {Count} stale vessels", removed);
            }
        }
        catch (OperationCanceledException)
        {
            // shutting down
        }
    }
}
