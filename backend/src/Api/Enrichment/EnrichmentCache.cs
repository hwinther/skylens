using System.Collections.Concurrent;
using Microsoft.Extensions.Caching.Memory;

namespace Skylens.Api.Enrichment;

/// <summary>
///     IMemoryCache with per-key single-flight: concurrent misses on the same key wait on a shared
///     <see cref="SemaphoreSlim" /> so the upstream factory runs exactly once (10 concurrent → 1 call).
///     Null factory results are not cached (so a transient upstream failure can be retried).
/// </summary>
public sealed class EnrichmentCache
{
    private readonly IMemoryCache _cache;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.Ordinal);

    public EnrichmentCache(IMemoryCache cache) => _cache = cache;

    public async Task<T?> GetOrCreateAsync<T>(
        string key,
        TimeSpan ttl,
        Func<CancellationToken, Task<T?>> factory,
        CancellationToken ct)
        where T : class
    {
        if (_cache.TryGetValue(key, out T? cached))
            return cached;

        var gate = _locks.GetOrAdd(key, static _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            // Re-check after acquiring: a prior holder may have populated it.
            if (_cache.TryGetValue(key, out cached))
                return cached;

            var value = await factory(ct);
            if (value is not null)
                _cache.Set(key, value, ttl);
            return value;
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>Return an already-cached value without running the factory (never an upstream call).</summary>
    public bool TryGet<T>(string key, out T? value) where T : class => _cache.TryGetValue(key, out value);
}
