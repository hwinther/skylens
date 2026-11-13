using System.Collections.Frozen;
using System.Globalization;
using System.IO.Compression;
using System.Text;
using Microsoft.Extensions.Options;
using Skylens.Api.Options;
using Skylens.Api.State;

namespace Skylens.Api.Enrichment;

/// <summary>
///     Loads the bundled GeoNames landmarks extract (<see cref="LandmarksOptions" />) into an immutable array
///     for the AR identify feature. Same fire-and-forget shape as <see cref="PortDbService" />: the load runs
///     in the background at startup, and until it finishes (or if the file is missing) <see cref="Nearby" />
///     returns nothing. The file is the extractor's own format — <c>id;kind;name;lat;lon;ele;pop;iso</c>, no
///     header, no quoting (the extractor strips semicolons from names) — so a plain split is enough.
/// </summary>
public sealed class LandmarkDbService : IHostedService
{
    /// <summary>Shown wherever the data is: CC BY 4.0 requires the GeoNames credit.</summary>
    public const string Attribution = "GeoNames (CC BY 4.0)";

    /// <summary>Hard cap on one answer (nearest first), so a request in dense mountains stays bounded.</summary>
    public const int MaxResults = 4000;

    /// <summary>
    ///     How far away a place of each kind is returned at all, whatever the requested radius: a village
    ///     25 km off is a speck you can't tell apart from the next one, a city still stands out at 80 km.
    ///     Peaks are only bounded by the radius (and, on the client, by the Earth's curvature).
    /// </summary>
    private static readonly FrozenDictionary<string, double> PlaceRangeKm = new Dictionary<string, double>
    {
        ["city"] = 80,
        ["town"] = 50,
        ["village"] = 25,
        ["hamlet"] = 12,
    }.ToFrozenDictionary(StringComparer.Ordinal);

    private static readonly FrozenSet<string> Kinds =
        new[] { "peak", "city", "town", "village", "hamlet" }.ToFrozenSet(StringComparer.Ordinal);

    private readonly LandmarksOptions _options;
    private readonly IHostEnvironment _env;
    private readonly ILogger<LandmarkDbService> _logger;

    private LandmarkDto[] _landmarks = [];
    private Task? _loadTask;

    public LandmarkDbService(IOptions<LandmarksOptions> options, IHostEnvironment env,
                             ILogger<LandmarkDbService> logger)
    {
        _options = options.Value;
        _env = env;
        _logger = logger;
    }

    public bool Loaded { get; private set; }
    public int Count => _landmarks.Length;

    /// <summary>The in-flight (or completed) background load — test seam so a test can await it.</summary>
    internal Task? LoadTask => _loadTask;

    /// <summary>
    ///     Landmarks within <paramref name="radiusKm" /> of the point (places further limited to their
    ///     kind's range), nearest-first, capped at <paramref name="limit" />.
    /// </summary>
    public IReadOnlyList<LandmarkDto> Nearby(double lat, double lon, double radiusKm, int limit)
    {
        var all = _landmarks;
        if (all.Length == 0 || limit <= 0)
            return [];

        // Cheap latitude band before the haversine (1° of latitude is ~111 km everywhere).
        var latBand = radiusKm / 111.0 + 0.01;
        var matches = new List<(double Dist, LandmarkDto Landmark)>();
        foreach (var l in all)
        {
            if (Math.Abs(l.Lat - lat) > latBand)
                continue;
            var d = Geo.DistanceKm(lat, lon, l.Lat, l.Lon);
            var reach = PlaceRangeKm.TryGetValue(l.Kind, out var placeRange) ? Math.Min(radiusKm, placeRange) : radiusKm;
            if (d <= reach)
                matches.Add((d, l));
        }

        matches.Sort(static (x, y) => x.Dist.CompareTo(y.Dist));
        if (matches.Count > limit)
            matches.RemoveRange(limit, matches.Count - limit);
        return matches.ConvertAll(static m => m.Landmark);
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _loadTask = Task.Run(() => Load(ResolvePath(_options.LandmarksPath)), CancellationToken.None);
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
                _logger.LogWarning("Landmarks DB not found at {Path}; AR identify will find nothing.", path);
                return;
            }

            using var stream = File.OpenRead(path);
            using var reader = path.EndsWith(".gz", StringComparison.OrdinalIgnoreCase)
                ? new StreamReader(new GZipStream(stream, CompressionMode.Decompress), Encoding.UTF8)
                : new StreamReader(stream, Encoding.UTF8);
            _landmarks = Parse(reader);
            Loaded = true;
            _logger.LogInformation("Loaded {Count} landmarks from {Path}", _landmarks.Length, path);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load landmarks DB from {Path}; continuing without it.", path);
        }
    }

    /// <summary>
    ///     Parses <c>id;kind;name;lat;lon;ele;pop;iso</c> rows. Malformed rows, unknown kinds, blank names and
    ///     peaks without an elevation are skipped; empty optional fields become null.
    /// </summary>
    internal static LandmarkDto[] Parse(TextReader reader)
    {
        var result = new List<LandmarkDto>();
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            var f = line.Split(';');
            if (f.Length < 8 || f[0].Length == 0 || !Kinds.Contains(f[1]))
                continue;
            var name = f[2].Trim();
            if (name.Length == 0)
                continue;
            if (!double.TryParse(f[3], NumberStyles.Float, CultureInfo.InvariantCulture, out var lat) ||
                !double.TryParse(f[4], NumberStyles.Float, CultureInfo.InvariantCulture, out var lon) ||
                lat is < -90 or > 90 || lon is < -180 or > 180)
                continue;
            int? ele = int.TryParse(f[5], NumberStyles.Integer, CultureInfo.InvariantCulture, out var e) ? e : null;
            int? pop = int.TryParse(f[6], NumberStyles.Integer, CultureInfo.InvariantCulture, out var p) && p > 0
                ? p
                : null;
            double? iso = double.TryParse(f[7], NumberStyles.Float, CultureInfo.InvariantCulture, out var i) && i >= 0
                ? i
                : null;
            if (f[1] == "peak" && ele is null)
                continue;
            result.Add(new LandmarkDto(f[0], f[1], name, lat, lon, ele, pop, f[1] == "peak" ? iso : null));
        }

        return result.ToArray();
    }
}
