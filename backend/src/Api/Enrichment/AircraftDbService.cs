using System.Collections.Frozen;
using System.IO.Compression;
using Microsoft.Extensions.Options;
using Skylens.Api.Options;

namespace Skylens.Api.Enrichment;

/// <summary>
///     Loads the bundled tar1090-db <c>aircraft.csv.gz</c> into a <see cref="FrozenDictionary{TKey,TValue}" />
///     keyed by lowercase hex. Loading runs on a background task at startup so it never blocks
///     <c>/healthz</c>; until it finishes (or if the file is missing) lookups just miss and callers
///     fall back to OpenSky. CSV format (semicolon-delimited):
///     <c>icao;registration;typecode;dbFlags;typeName;;;</c>.
/// </summary>
public sealed class AircraftDbService : IHostedService
{
    private readonly AircraftDbOptions _options;
    private readonly ILogger<AircraftDbService> _logger;
    private FrozenDictionary<string, AircraftMetadata> _db = FrozenDictionary<string, AircraftMetadata>.Empty;

    public AircraftDbService(IOptions<AircraftDbOptions> options, ILogger<AircraftDbService> logger)
    {
        _options = options.Value;
        _logger = logger;
    }

    public bool Loaded { get; private set; }
    public int Count => _db.Count;

    public bool TryGet(string hex, out AircraftMetadata? metadata)
    {
        var ok = _db.TryGetValue(hex.ToLowerInvariant(), out var m);
        metadata = m;
        return ok;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Fire-and-forget: don't block host startup / healthz on a ~600k-row parse.
        _ = Task.Run(() => Load(_options.Path), CancellationToken.None);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    internal void Load(string path)
    {
        try
        {
            if (!File.Exists(path))
            {
                _logger.LogWarning("Aircraft DB not found at {Path}; enrichment will rely on OpenSky fallback.", path);
                return;
            }

            var map = ParseCsvGz(path);
            _db = map.ToFrozenDictionary(StringComparer.Ordinal);
            Loaded = true;
            _logger.LogInformation("Loaded {Count} aircraft DB rows from {Path}", _db.Count, path);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load aircraft DB from {Path}; continuing without it.", path);
        }
    }

    internal static Dictionary<string, AircraftMetadata> ParseCsvGz(string path)
    {
        using var file = File.OpenRead(path);
        using var gz = new GZipStream(file, CompressionMode.Decompress);
        using var reader = new StreamReader(gz);
        return ParseCsv(reader);
    }

    internal static Dictionary<string, AircraftMetadata> ParseCsv(TextReader reader)
    {
        var map = new Dictionary<string, AircraftMetadata>(StringComparer.Ordinal);
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0)
                continue;

            // Fields: hex ; registration ; typecode ; dbFlags ; typeName ; ...
            var parts = line.Split(';');
            if (parts.Length < 1)
                continue;

            var hex = parts[0].Trim().ToLowerInvariant();
            if (hex.Length == 0)
                continue;

            map[hex] = new AircraftMetadata
            {
                Hex = hex,
                Registration = Field(parts, 1),
                TypeCode = Field(parts, 2),
                TypeName = Field(parts, 4),
                Source = "db",
            };
        }

        return map;
    }

    private static string? Field(string[] parts, int index) =>
        index < parts.Length && parts[index].Trim() is { Length: > 0 } v ? v : null;
}
