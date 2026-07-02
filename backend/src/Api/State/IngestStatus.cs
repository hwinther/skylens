namespace Skylens.Api.State;

/// <summary>
///     Shared, thread-safe view of MQTT ingest health for <c>/healthz</c>. Degraded if the last
///     message is older than <see cref="StaleThreshold" /> (or none has arrived yet).
/// </summary>
public sealed class IngestStatus
{
    public static readonly TimeSpan StaleThreshold = TimeSpan.FromSeconds(30);

    private long _lastMessageTicks; // DateTimeOffset.UtcTicks of last message, 0 = never
    private volatile bool _connected;
    private long _messageCount;
    private volatile int _lastAircraftCount;

    public bool Connected => _connected;
    public long MessageCount => Interlocked.Read(ref _messageCount);
    public int LastAircraftCount => _lastAircraftCount;

    public DateTimeOffset? LastMessageAt
    {
        get
        {
            var ticks = Interlocked.Read(ref _lastMessageTicks);
            return ticks == 0 ? null : new DateTimeOffset(ticks, TimeSpan.Zero);
        }
    }

    public void MarkConnected() => _connected = true;

    public void MarkDisconnected() => _connected = false;

    public void MarkMessage(DateTimeOffset at, int aircraftCount, double? feedNow)
    {
        Interlocked.Exchange(ref _lastMessageTicks, at.UtcTicks);
        Interlocked.Increment(ref _messageCount);
        _lastAircraftCount = aircraftCount;
        _ = feedNow; // reserved: the dump1090 `now` field, if we later want clock-skew diagnostics
    }

    /// <summary>True when a message has arrived within <see cref="StaleThreshold" /> of <paramref name="now" />.</summary>
    public bool IsFresh(DateTimeOffset now)
    {
        var last = LastMessageAt;
        return last is not null && now - last.Value <= StaleThreshold;
    }
}
