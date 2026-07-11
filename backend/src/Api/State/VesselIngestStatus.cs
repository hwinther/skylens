namespace Skylens.Api.State;

/// <summary>
///     Shared, thread-safe view of AIS ingest health for <c>/healthz</c>. Stale if the last AIS message
///     is older than <see cref="StaleThreshold" /> (or none has arrived yet). Mirrors <see cref="IngestStatus" />
///     minus the connection flag: AIS rides the aircraft feed's single MQTT connection, so healthz reports
///     connectivity from <see cref="IngestStatus" />. The threshold is longer than the aircraft feed's
///     because AIS messages arrive far less frequently.
/// </summary>
public sealed class VesselIngestStatus
{
    public static readonly TimeSpan StaleThreshold = TimeSpan.FromMinutes(15);

    private long _lastMessageTicks; // DateTimeOffset.UtcTicks of last message, 0 = never
    private long _messageCount;
    private volatile int _lastVesselCount;

    public long MessageCount => Interlocked.Read(ref _messageCount);
    public int LastVesselCount => _lastVesselCount;

    public DateTimeOffset? LastMessageAt
    {
        get
        {
            var ticks = Interlocked.Read(ref _lastMessageTicks);
            return ticks == 0 ? null : new DateTimeOffset(ticks, TimeSpan.Zero);
        }
    }

    public void MarkMessage(DateTimeOffset at, int vesselCount)
    {
        Interlocked.Exchange(ref _lastMessageTicks, at.UtcTicks);
        Interlocked.Increment(ref _messageCount);
        _lastVesselCount = vesselCount;
    }

    /// <summary>True when a message has arrived within <see cref="StaleThreshold" /> of <paramref name="now" />.</summary>
    public bool IsFresh(DateTimeOffset now)
    {
        var last = LastMessageAt;
        return last is not null && now - last.Value <= StaleThreshold;
    }
}
