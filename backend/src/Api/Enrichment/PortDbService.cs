using System.Collections.Frozen;
using System.Globalization;
using System.IO.Compression;
using System.Text;
using Microsoft.Extensions.Options;
using Skylens.Api.Options;
using Skylens.Api.State;

namespace Skylens.Api.Enrichment;

/// <summary>
///     Loads the bundled OpenStreetMap ports extract (<see cref="PortsOptions" />) into an immutable array.
///     Same fire-and-forget shape as <see cref="AirportDbService" />: the load runs in the background at
///     startup, and until it finishes (or if the file is missing) <see cref="Nearby" /> returns nothing.
///     The file is the extractor's own format — <c>id;kind;name;lat;lon</c>, no header, no quoting (the
///     extractor strips semicolons from names) — so a plain split is enough.
/// </summary>
public sealed class PortDbService : IHostedService
{
    /// <summary>Shown wherever the data is: ODbL requires the OSM credit; the WPI (US public domain) is credited as the source.</summary>
    public const string Attribution = "© OpenStreetMap contributors (ODbL) · World Port Index (NGA)";

    private static readonly FrozenSet<string> Kinds =
        new[] { "port", "harbour", "marina", "ferry" }.ToFrozenSet(StringComparer.Ordinal);

    private readonly PortsOptions _options;
    private readonly IHostEnvironment _env;
    private readonly ILogger<PortDbService> _logger;

    private PortDto[] _ports = [];
    private Task? _loadTask;

    public PortDbService(IOptions<PortsOptions> options, IHostEnvironment env, ILogger<PortDbService> logger)
    {
        _options = options.Value;
        _env = env;
        _logger = logger;
    }

    public bool Loaded { get; private set; }
    public int Count => _ports.Length;

    /// <summary>The in-flight (or completed) background load — test seam so a test can await it.</summary>
    internal Task? LoadTask => _loadTask;

    /// <summary>Ports within <paramref name="radiusKm" /> of the point, nearest-first, capped at <paramref name="limit" />.</summary>
    public IReadOnlyList<PortDto> Nearby(double lat, double lon, double radiusKm, int limit)
    {
        var all = _ports;
        if (all.Length == 0 || limit <= 0)
            return [];

        var matches = new List<(double Dist, PortDto Port)>();
        foreach (var p in all)
        {
            var d = Geo.DistanceKm(lat, lon, p.Lat, p.Lon);
            if (d <= radiusKm)
                matches.Add((d, p));
        }

        matches.Sort(static (x, y) => x.Dist.CompareTo(y.Dist));
        if (matches.Count > limit)
            matches.RemoveRange(limit, matches.Count - limit);
        return matches.ConvertAll(static m => m.Port);
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _loadTask = Task.Run(() => Load(ResolvePath(_options.PortsPath)), CancellationToken.None);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private string ResolvePath(string path) =>
        Path.IsPathRooted(path) ? path : Path.GetFullPath(Path.Combine(_env.ContentRootPath, path));

    internal void Load(string path)
    {
        try
        {
            if (!File.Exists(path))
            {
                _logger.LogWarning("Ports DB not found at {Path}; the ports layer will be empty.", path);
                return;
            }

            using var stream = File.OpenRead(path);
            using var reader = path.EndsWith(".gz", StringComparison.OrdinalIgnoreCase)
                ? new StreamReader(new GZipStream(stream, CompressionMode.Decompress), Encoding.UTF8)
                : new StreamReader(stream, Encoding.UTF8);
            _ports = Parse(reader);
            Loaded = true;
            _logger.LogInformation("Loaded {Count} ports from {Path}", _ports.Length, path);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load ports DB from {Path}; continuing without it.", path);
        }
    }

    /// <summary>Parses <c>id;kind;name;lat;lon</c> rows; malformed rows and unknown kinds are skipped.</summary>
    internal static PortDto[] Parse(TextReader reader)
    {
        var result = new List<PortDto>();
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            var f = line.Split(';');
            if (f.Length < 5 || f[0].Length == 0 || !Kinds.Contains(f[1]))
                continue;
            if (!double.TryParse(f[3], NumberStyles.Float, CultureInfo.InvariantCulture, out var lat) ||
                !double.TryParse(f[4], NumberStyles.Float, CultureInfo.InvariantCulture, out var lon) ||
                lat is < -90 or > 90 || lon is < -180 or > 180)
                continue;
            var name = f[2].Trim();
            result.Add(new PortDto(f[0], f[1], name.Length == 0 ? null : name, lat, lon));
        }

        return result.ToArray();
    }
}
