using System.Collections.Concurrent;

namespace Skylens.Api.State;

/// <summary>
///     In-memory current-picture of all tracked aircraft, keyed by lowercase ICAO hex. Updates merge
///     non-null fields; entries not seen for <see cref="Ttl" /> are evicted by a background
///     <see cref="PeriodicTimer" />. <see cref="TimeProvider" /> is injected so tests drive the clock.
/// </summary>
public sealed class AircraftStateStore : BackgroundService
{
    public static readonly TimeSpan Ttl = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan EvictionInterval = TimeSpan.FromSeconds(10);

    private readonly ConcurrentDictionary<string, AircraftState> _byHex = new(StringComparer.Ordinal);
    private readonly TimeProvider _time;
    private readonly ILogger<AircraftStateStore> _logger;

    public AircraftStateStore(TimeProvider time, ILogger<AircraftStateStore> logger)
    {
        _time = time;
        _logger = logger;
    }

    public int Count => _byHex.Count;

    /// <summary>Apply a batch of parsed updates from one snapshot.</summary>
    public void ApplyUpdates(IEnumerable<Ingest.AircraftUpdate> updates)
    {
        var now = _time.GetUtcNow();
        foreach (var u in updates)
        {
            _byHex.AddOrUpdate(
                u.Hex,
                static (_, arg) => AircraftState.FromUpdate(arg.u, arg.now),
                static (_, existing, arg) =>
                {
                    existing.Merge(arg.u, arg.now);
                    return existing;
                },
                (u, now));
        }
    }

    public bool TryGet(string hex, out AircraftState? state)
    {
        var ok = _byHex.TryGetValue(hex.ToLowerInvariant(), out var s);
        state = s;
        return ok;
    }

    /// <summary>Snapshot of all current aircraft (a copy of the values; safe to enumerate).</summary>
    public IReadOnlyList<AircraftState> Snapshot() => _byHex.Values.ToArray();

    /// <summary>Evict entries older than the TTL relative to <paramref name="now" />. Returns evicted count.</summary>
    public int Evict(DateTimeOffset now)
    {
        var removed = 0;
        foreach (var kvp in _byHex)
        {
            if (now - kvp.Value.LastSeenUtc > Ttl && _byHex.TryRemove(kvp.Key, out _))
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
                    _logger.LogDebug("Evicted {Count} stale aircraft", removed);
            }
        }
        catch (OperationCanceledException)
        {
            // shutting down
        }
    }
}
