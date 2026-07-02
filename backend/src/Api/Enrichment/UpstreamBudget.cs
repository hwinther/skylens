namespace Skylens.Api.Enrichment;

/// <summary>
///     A rolling call-count budget for one upstream provider over a fixed window (monthly for ADSBx,
///     daily for AeroAPI). Fails closed: once the window's limit is hit, <see cref="TryConsume" />
///     returns false until the window rolls over. Thread-safe. <see cref="TimeProvider" /> injected for tests.
/// </summary>
public sealed class UpstreamBudget
{
    private readonly int _limit;
    private readonly Func<DateTimeOffset, DateTimeOffset> _windowStart;
    private readonly TimeProvider _time;
    private readonly object _gate = new();

    private DateTimeOffset _currentWindow;
    private int _used;

    private UpstreamBudget(int limit, Func<DateTimeOffset, DateTimeOffset> windowStart, TimeProvider time)
    {
        _limit = limit;
        _windowStart = windowStart;
        _time = time;
        _currentWindow = windowStart(time.GetUtcNow());
    }

    public static UpstreamBudget Monthly(int limit, TimeProvider time) =>
        new(limit, static now => new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, TimeSpan.Zero), time);

    public static UpstreamBudget Daily(int limit, TimeProvider time) =>
        new(limit, static now => new DateTimeOffset(now.Year, now.Month, now.Day, 0, 0, 0, TimeSpan.Zero), time);

    public int Limit => _limit;

    public int Used
    {
        get
        {
            lock (_gate)
            {
                RollIfNeeded();
                return _used;
            }
        }
    }

    public int Remaining => Math.Max(0, _limit - Used);

    /// <summary>Consume one unit if budget remains. Returns false (without consuming) when exhausted.</summary>
    public bool TryConsume()
    {
        lock (_gate)
        {
            RollIfNeeded();
            if (_used >= _limit)
                return false;
            _used++;
            return true;
        }
    }

    private void RollIfNeeded()
    {
        var window = _windowStart(_time.GetUtcNow());
        if (window != _currentWindow)
        {
            _currentWindow = window;
            _used = 0;
        }
    }
}
