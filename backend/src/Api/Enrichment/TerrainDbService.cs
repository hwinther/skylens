using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using Microsoft.Extensions.Options;
using Skylens.Api.Options;

namespace Skylens.Api.Enrichment;

/// <summary>
///     Loads the bundled ETOPO 2022 elevation grids (<see cref="TerrainOptions" />) and resamples them into a
///     small radar-centred grid on request. Same fire-and-forget shape as <see cref="LandmarkDbService" />: the
///     load runs in the background at startup, and until it finishes (or if the file is missing)
///     <see cref="Sample" /> returns null. ~6 MB in memory (one byte per source cell).
/// </summary>
public sealed class TerrainDbService : IHostedService
{
    /// <summary>Shown wherever the relief is drawn (a US Government work: credit, no licence terms).</summary>
    public const string Attribution = "ETOPO 2022 (NOAA NCEI)";

    /// <summary>Largest grid side returned, whatever the radius: 129² heights (~60 kB of JSON, ~15 kB gzipped).</summary>
    public const int MaxCells = 129;

    /// <summary>Smallest cell returned: finer than the ~0.9 km source would only repeat samples.</summary>
    public const double MinCellKm = 0.5;

    public const double MinRadiusKm = 1;
    public const double MaxRadiusKm = 500;

    private const double EarthRadiusKm = 6371.0088;
    private static readonly byte[] Magic = "SKYTERR1"u8.ToArray();

    private readonly TerrainOptions _options;
    private readonly IHostEnvironment _env;
    private readonly ILogger<TerrainDbService> _logger;

    private Grid[] _grids = [];
    private Task? _loadTask;

    public TerrainDbService(IOptions<TerrainOptions> options, IHostEnvironment env, ILogger<TerrainDbService> logger)
    {
        _options = options.Value;
        _env = env;
        _logger = logger;
    }

    public bool Loaded { get; private set; }

    /// <summary>The in-flight (or completed) background load — test seam so a test can await it.</summary>
    internal Task? LoadTask => _loadTask;

    /// <summary>
    ///     The radar grid around (<paramref name="lat" />, <paramref name="lon" />) covering
    ///     <paramref name="radiusKm" /> (clamped to [<see cref="MinRadiusKm" />, <see cref="MaxRadiusKm" />]):
    ///     cells of max(<see cref="MinCellKm" />, 2r / (MaxCells − 1)) km, at most <see cref="MaxCells" /> a side.
    ///     Null before the DB has loaded.
    /// </summary>
    public TerrainSample? Sample(double lat, double lon, double radiusKm) =>
        _grids.Length == 0 ? null : Sample(_grids, lat, lon, radiusKm);

    internal static TerrainSample Sample(IReadOnlyList<Grid> grids, double lat, double lon, double radiusKm)
    {
        var r = Math.Clamp(radiusKm, MinRadiusKm, MaxRadiusKm);
        var cellKm = Math.Max(MinCellKm, 2 * r / (MaxCells - 1));
        var half = (int)Math.Ceiling(r / cellKm - 1e-9);
        var n = 2 * half + 1;
        // A cell much coarser than the source averages a few sub-samples, so a long range doesn't alias.
        var sub = Math.Clamp((int)Math.Round(cellKm / 1.5), 1, 4);
        var heights = new int[n * n];
        for (var row = 0; row < n; row++)
        {
            for (var col = 0; col < n; col++)
            {
                double sum = 0;
                var land = 0;
                for (var a = 0; a < sub; a++)
                {
                    for (var b = 0; b < sub; b++)
                    {
                        var x = (col - half + (b + 0.5) / sub - 0.5) * cellKm;
                        var y = (half - row - (a + 0.5) / sub + 0.5) * cellKm;
                        var dist = Math.Sqrt(x * x + y * y);
                        var (pLat, pLon) = dist == 0 ? (lat, lon) : Destination(lat, lon, Math.Atan2(x, y), dist);
                        var m = Lookup(grids, pLat, pLon);
                        if (m > 0)
                        {
                            sum += m;
                            land++;
                        }
                    }
                }

                // Mostly land → its mean height (at least 10 m, so land never reads as sea); else sea.
                heights[row * n + col] = land * 2 > sub * sub
                    ? Math.Max(10, (int)Math.Round(sum / land / 10) * 10)
                    : 0;
            }
        }

        return new TerrainSample(cellKm, n, heights);
    }

    /// <summary>Height in metres at a point from the finest grid that covers it (0 = sea or no coverage).</summary>
    internal static int Lookup(IReadOnlyList<Grid> grids, double lat, double lon)
    {
        foreach (var g in grids)
        {
            var i = (int)Math.Round((lat - g.South) / g.DLat);
            var j = (int)Math.Round((lon - g.West) / g.DLon);
            if (g.WrapsLongitude)
                j = ((j % g.Cols) + g.Cols) % g.Cols;
            if (i >= 0 && i < g.Rows && j >= 0 && j < g.Cols)
                return Decode(g.Codes[i * g.Cols + j]);
        }

        return 0;
    }

    /// <summary>Code byte → metres: 0 sea, 1–200 = c × 10 m, 201–255 = 2000 + (c − 200) × 125 m.</summary>
    internal static int Decode(byte c) => c <= 200 ? c * 10 : 2000 + (c - 200) * 125;

    /// <summary>Destination along an initial bearing (radians) for a distance, on a spherical earth.</summary>
    internal static (double Lat, double Lon) Destination(double lat, double lon, double bearingRad, double distKm)
    {
        var d = distKm / EarthRadiusKm;
        var p1 = lat * Math.PI / 180;
        var l1 = lon * Math.PI / 180;
        var p2 = Math.Asin(Math.Sin(p1) * Math.Cos(d) + Math.Cos(p1) * Math.Sin(d) * Math.Cos(bearingRad));
        var l2 = l1 + Math.Atan2(Math.Sin(bearingRad) * Math.Sin(d) * Math.Cos(p1),
                                 Math.Cos(d) - Math.Sin(p1) * Math.Sin(p2));
        var lonDeg = (l2 * 180 / Math.PI + 540) % 360 - 180;
        return (p2 * 180 / Math.PI, lonDeg);
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _loadTask = Task.Run(() => Load(ResolvePath(_options.TerrainPath)), CancellationToken.None);
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
                _logger.LogWarning("Terrain DB not found at {Path}; the radar relief will be empty.", path);
                return;
            }

            using var stream = File.OpenRead(path);
            using var gz = new GZipStream(stream, CompressionMode.Decompress);
            _grids = Parse(gz);
            Loaded = true;
            _logger.LogInformation("Loaded {Count} terrain grids ({Cells} cells) from {Path}", _grids.Length,
                                   _grids.Sum(static g => (long)g.Codes.Length), path);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load terrain DB from {Path}; continuing without it.", path);
        }
    }

    /// <summary>
    ///     Parses the uncompressed <c>SKYTERR1</c> format (see <c>data/terrain/build-etopo-terrain.mjs</c>) and
    ///     undoes the row "up" filter. Throws <see cref="InvalidDataException" /> on a bad magic, implausible
    ///     header or truncated body.
    /// </summary>
    internal static Grid[] Parse(Stream stream)
    {
        using var reader = new BinaryReader(stream, Encoding.ASCII, leaveOpen: true);
        var magic = reader.ReadBytes(Magic.Length);
        if (!magic.AsSpan().SequenceEqual(Magic))
            throw new InvalidDataException("not a SKYTERR1 terrain file");
        var count = reader.ReadByte();
        var grids = new Grid[count];
        Span<byte> header = stackalloc byte[40];
        for (var k = 0; k < count; k++)
        {
            if (reader.Read(header) != header.Length)
                throw new InvalidDataException("truncated grid header");
            var south = BinaryPrimitives.ReadDoubleLittleEndian(header[..8]);
            var west = BinaryPrimitives.ReadDoubleLittleEndian(header[8..16]);
            var dLat = BinaryPrimitives.ReadDoubleLittleEndian(header[16..24]);
            var dLon = BinaryPrimitives.ReadDoubleLittleEndian(header[24..32]);
            var rows = BinaryPrimitives.ReadUInt32LittleEndian(header[32..36]);
            var cols = BinaryPrimitives.ReadUInt32LittleEndian(header[36..40]);
            if (rows is 0 or > 50_000 || cols is 0 or > 50_000 || !(dLat > 0) || !(dLon > 0) ||
                !double.IsFinite(south) || !double.IsFinite(west))
                throw new InvalidDataException("implausible grid header");
            var codes = reader.ReadBytes(checked((int)(rows * cols)));
            if (codes.Length != rows * cols)
                throw new InvalidDataException("truncated grid body");
            for (var i = (int)cols; i < codes.Length; i++)
                codes[i] = unchecked((byte)(codes[i] + codes[i - cols]));
            grids[k] = new Grid(south, west, dLat, dLon, (int)rows, (int)cols, codes);
        }

        return grids;
    }

    /// <summary>One source grid: cell centres from (South, West) every (DLat, DLon) degrees, row 0 southernmost.</summary>
    internal sealed record Grid(double South, double West, double DLat, double DLon, int Rows, int Cols, byte[] Codes)
    {
        /// <summary>A global grid wraps at the antimeridian.</summary>
        public bool WrapsLongitude => Cols * DLon >= 359.9;
    }
}
