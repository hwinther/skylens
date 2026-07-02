namespace Skylens.Api.Enrichment;

/// <summary>
///     Resolves aircraft metadata: offline DB first, OpenSky fallback on a miss (cached 7 days,
///     single-flight per hex). This is the type endpoints depend on for <c>/api/aircraft/{hex}</c>.
/// </summary>
public sealed class MetadataService
{
    private static readonly TimeSpan OpenSkyCacheTtl = TimeSpan.FromDays(7);

    private readonly AircraftDbService _db;
    private readonly OpenSkyMetadataClient _openSky;
    private readonly EnrichmentCache _cache;

    public MetadataService(AircraftDbService db, OpenSkyMetadataClient openSky, EnrichmentCache cache)
    {
        _db = db;
        _openSky = openSky;
        _cache = cache;
    }

    public async Task<AircraftMetadata?> GetAsync(string hex, CancellationToken ct)
    {
        var key = hex.ToLowerInvariant();
        if (_db.TryGet(key, out var fromDb) && fromDb is not null)
            return fromDb;

        return await _cache.GetOrCreateAsync(
            $"opensky:{key}",
            OpenSkyCacheTtl,
            innerCt => _openSky.LookupAsync(key, innerCt),
            ct);
    }
}
