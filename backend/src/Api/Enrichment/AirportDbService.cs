using System.Collections.Frozen;
using System.Globalization;
using System.IO.Compression;
using System.Text;
using Microsoft.Extensions.Options;
using Skylens.Api.Options;
using Skylens.Api.State;

namespace Skylens.Api.Enrichment;

/// <summary>
///     Loads the bundled public-domain OurAirports dataset (airports + runways + frequencies) into an
///     immutable array of joined <see cref="AirportDto" /> records. Loading runs on a background task at
///     startup so it never blocks <c>/healthz</c> — until it finishes (or if the files are missing)
///     <see cref="Nearby" /> just returns nothing. Mirrors <see cref="AircraftDbService" />'s
///     fire-and-forget shape, but the CSVs are RFC-4180 with quoted fields (airport names carry commas
///     and embedded quotes), so a proper quoted-field splitter is used and columns are read by
///     header-name index (the dataset occasionally adds columns).
///     <para>
///         Each source path is decompressed only when it ends <c>.gz</c> (prod bakes gzipped CSVs; the
///         Development fixtures are plain <c>.csv</c>). Absolute paths are used as-is; relative paths
///         resolve against the content root so <c>dotnet run</c> / tests find the fixtures.
///     </para>
/// </summary>
public sealed class AirportDbService : IHostedService
{
    /// <summary>OurAirports classes kept; <c>closed</c>/<c>balloonport</c> and unlisted types are dropped.</summary>
    private static readonly FrozenSet<string> KeptTypes = new[]
    {
        "large_airport", "medium_airport", "small_airport", "heliport", "seaplane_base",
    }.ToFrozenSet(StringComparer.Ordinal);

    private readonly AirportsOptions _options;
    private readonly IHostEnvironment _env;
    private readonly ILogger<AirportDbService> _logger;

    private AirportDto[] _airports = [];
    private Task? _loadTask;

    public AirportDbService(IOptions<AirportsOptions> options, IHostEnvironment env, ILogger<AirportDbService> logger)
    {
        _options = options.Value;
        _env = env;
        _logger = logger;
    }

    public bool Loaded { get; private set; }
    public int Count => _airports.Length;

    /// <summary>The in-flight (or completed) background load — test seam so a test can await the load.</summary>
    internal Task? LoadTask => _loadTask;

    /// <summary>
    ///     Airports within <paramref name="radiusKm" /> of the point, nearest-first, capped at
    ///     <paramref name="limit" />. Returns an empty list before the dataset has loaded.
    /// </summary>
    public IReadOnlyList<AirportDto> Nearby(double lat, double lon, double radiusKm, int limit)
    {
        var all = _airports;
        if (all.Length == 0 || limit <= 0)
            return [];

        var matches = new List<(double Dist, AirportDto Airport)>();
        foreach (var a in all)
        {
            var d = Geo.DistanceKm(lat, lon, a.Lat, a.Lon);
            if (d <= radiusKm)
                matches.Add((d, a));
        }

        matches.Sort(static (x, y) => x.Dist.CompareTo(y.Dist));
        if (matches.Count > limit)
            matches.RemoveRange(limit, matches.Count - limit);

        var result = new AirportDto[matches.Count];
        for (var i = 0; i < matches.Count; i++)
            result[i] = matches[i].Airport;
        return result;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Fire-and-forget: don't block host startup / healthz on the ~80k-row parse.
        _loadTask = Task.Run(
            () => Load(
                ResolvePath(_options.AirportsPath),
                ResolvePath(_options.RunwaysPath),
                ResolvePath(_options.FrequenciesPath)),
            CancellationToken.None);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    /// <summary>Absolute paths are used as-is; relative paths resolve against the content root.</summary>
    private string ResolvePath(string path) =>
        Path.IsPathRooted(path) ? path : Path.GetFullPath(Path.Combine(_env.ContentRootPath, path));

    internal void Load(string airportsPath, string runwaysPath, string frequenciesPath)
    {
        try
        {
            if (!File.Exists(airportsPath))
            {
                _logger.LogWarning("Airports DB not found at {Path}; the airports layer will be empty.", airportsPath);
                return;
            }

            var runways = File.Exists(runwaysPath)
                ? ParseRunways(runwaysPath)
                : new Dictionary<string, List<RunwayDto>>(StringComparer.Ordinal);
            var frequencies = File.Exists(frequenciesPath)
                ? ParseFrequencies(frequenciesPath)
                : new Dictionary<string, List<AirportFrequencyDto>>(StringComparer.Ordinal);

            var airports = ParseAirports(airportsPath, runways, frequencies);
            _airports = airports;
            Loaded = true;
            _logger.LogInformation("Loaded {Count} airports from {Path}", airports.Length, airportsPath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load airports DB from {Path}; continuing without it.", airportsPath);
        }
    }

    // -- Parsing -------------------------------------------------------------------------------------

    internal static AirportDto[] ParseAirports(
        string path,
        Dictionary<string, List<RunwayDto>> runways,
        Dictionary<string, List<AirportFrequencyDto>> frequencies)
    {
        using var reader = OpenCsv(path);
        return ParseAirports(reader, runways, frequencies);
    }

    internal static AirportDto[] ParseAirports(
        TextReader reader,
        Dictionary<string, List<RunwayDto>> runways,
        Dictionary<string, List<AirportFrequencyDto>> frequencies)
    {
        if (reader.ReadLine() is not { } header)
            return [];
        var cols = HeaderMap(header);

        var identIdx = Col(cols, "ident");
        var typeIdx = Col(cols, "type");
        var nameIdx = Col(cols, "name");
        var latIdx = Col(cols, "latitude_deg");
        var lonIdx = Col(cols, "longitude_deg");
        var elevIdx = Col(cols, "elevation_ft");
        var muniIdx = Col(cols, "municipality");
        var iataIdx = Col(cols, "iata_code");

        var result = new List<AirportDto>();
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0)
                continue;
            var f = SplitCsvLine(line);

            var type = Get(f, typeIdx);
            if (type is null || !KeptTypes.Contains(type))
                continue;

            var lat = ParseDouble(Get(f, latIdx));
            var lon = ParseDouble(Get(f, lonIdx));
            if (lat is null || lon is null)
                continue;

            var ident = Get(f, identIdx);
            if (string.IsNullOrEmpty(ident))
                continue;

            var rwys = runways.TryGetValue(ident, out var r) ? (IReadOnlyList<RunwayDto>)r : [];
            var freqs = frequencies.TryGetValue(ident, out var fr) ? (IReadOnlyList<AirportFrequencyDto>)fr : [];

            result.Add(new AirportDto(
                Ident: ident,
                Iata: Blank(Get(f, iataIdx)),
                Name: Blank(Get(f, nameIdx)) ?? ident,
                Type: type,
                Lat: lat.Value,
                Lon: lon.Value,
                ElevationFt: ParseInt(Get(f, elevIdx)),
                Municipality: Blank(Get(f, muniIdx)),
                Runways: rwys,
                Frequencies: freqs));
        }

        return result.ToArray();
    }

    internal static Dictionary<string, List<RunwayDto>> ParseRunways(string path)
    {
        using var reader = OpenCsv(path);
        return ParseRunways(reader);
    }

    internal static Dictionary<string, List<RunwayDto>> ParseRunways(TextReader reader)
    {
        var map = new Dictionary<string, List<RunwayDto>>(StringComparer.Ordinal);
        if (reader.ReadLine() is not { } header)
            return map;
        var cols = HeaderMap(header);

        var aptIdx = Col(cols, "airport_ident");
        var lenIdx = Col(cols, "length_ft");
        var surfIdx = Col(cols, "surface");
        var closedIdx = Col(cols, "closed");
        var leIdentIdx = Col(cols, "le_ident");
        var leLatIdx = Col(cols, "le_latitude_deg");
        var leLonIdx = Col(cols, "le_longitude_deg");
        var heIdentIdx = Col(cols, "he_ident");
        var heLatIdx = Col(cols, "he_latitude_deg");
        var heLonIdx = Col(cols, "he_longitude_deg");

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0)
                continue;
            var f = SplitCsvLine(line);

            var apt = Get(f, aptIdx);
            if (string.IsNullOrEmpty(apt))
                continue;
            if (Get(f, closedIdx) == "1")
                continue;

            var runway = new RunwayDto(
                LeIdent: Blank(Get(f, leIdentIdx)),
                HeIdent: Blank(Get(f, heIdentIdx)),
                LengthFt: ParseInt(Get(f, lenIdx)),
                Surface: Blank(Get(f, surfIdx)),
                LeLat: ParseDouble(Get(f, leLatIdx)),
                LeLon: ParseDouble(Get(f, leLonIdx)),
                HeLat: ParseDouble(Get(f, heLatIdx)),
                HeLon: ParseDouble(Get(f, heLonIdx)));

            if (!map.TryGetValue(apt, out var list))
                map[apt] = list = new List<RunwayDto>();
            list.Add(runway);
        }

        return map;
    }

    internal static Dictionary<string, List<AirportFrequencyDto>> ParseFrequencies(string path)
    {
        using var reader = OpenCsv(path);
        return ParseFrequencies(reader);
    }

    internal static Dictionary<string, List<AirportFrequencyDto>> ParseFrequencies(TextReader reader)
    {
        var map = new Dictionary<string, List<AirportFrequencyDto>>(StringComparer.Ordinal);
        if (reader.ReadLine() is not { } header)
            return map;
        var cols = HeaderMap(header);

        var aptIdx = Col(cols, "airport_ident");
        var typeIdx = Col(cols, "type");
        var descIdx = Col(cols, "description");
        var mhzIdx = Col(cols, "frequency_mhz");

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0)
                continue;
            var f = SplitCsvLine(line);

            var apt = Get(f, aptIdx);
            if (string.IsNullOrEmpty(apt))
                continue;

            // frequency_mhz uses a decimal POINT — parse with InvariantCulture. Drop rows we can't parse.
            var mhz = ParseDouble(Get(f, mhzIdx));
            if (mhz is null)
                continue;

            var freq = new AirportFrequencyDto(
                Type: Blank(Get(f, typeIdx)) ?? "",
                Description: Blank(Get(f, descIdx)),
                Mhz: mhz.Value);

            if (!map.TryGetValue(apt, out var list))
                map[apt] = list = new List<AirportFrequencyDto>();
            list.Add(freq);
        }

        return map;
    }

    // -- CSV helpers ---------------------------------------------------------------------------------

    /// <summary>Open a CSV, decompressing only when the path ends <c>.gz</c> (disposing the reader closes the chain).</summary>
    private static TextReader OpenCsv(string path)
    {
        Stream stream = File.OpenRead(path);
        if (path.EndsWith(".gz", StringComparison.OrdinalIgnoreCase))
            stream = new GZipStream(stream, CompressionMode.Decompress);
        return new StreamReader(stream);
    }

    /// <summary>
    ///     Split one RFC-4180 CSV line into fields: commas separate, double-quotes wrap a field (so a
    ///     comma inside stays literal), and a doubled <c>""</c> inside a quoted field is a literal quote.
    ///     Surrounding quotes are stripped. Embedded newlines are not handled (the dataset has none).
    /// </summary>
    internal static List<string> SplitCsvLine(string line)
    {
        var fields = new List<string>();
        var sb = new StringBuilder();
        var inQuotes = false;

        for (var i = 0; i < line.Length; i++)
        {
            var c = line[i];
            if (inQuotes)
            {
                if (c == '"')
                {
                    if (i + 1 < line.Length && line[i + 1] == '"')
                    {
                        sb.Append('"');
                        i++; // consume the escaped quote
                    }
                    else
                    {
                        inQuotes = false;
                    }
                }
                else
                {
                    sb.Append(c);
                }
            }
            else if (c == '"')
            {
                inQuotes = true;
            }
            else if (c == ',')
            {
                fields.Add(sb.ToString());
                sb.Clear();
            }
            else
            {
                sb.Append(c);
            }
        }

        fields.Add(sb.ToString());
        return fields;
    }

    /// <summary>Map (trimmed, unquoted) header names → column index; case-insensitive.</summary>
    private static Dictionary<string, int> HeaderMap(string header)
    {
        var fields = SplitCsvLine(header);
        var map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < fields.Count; i++)
            map[fields[i].Trim()] = i;
        return map;
    }

    private static int Col(Dictionary<string, int> cols, string name) =>
        cols.TryGetValue(name, out var i) ? i : -1;

    private static string? Get(List<string> fields, int index) =>
        index >= 0 && index < fields.Count ? fields[index] : null;

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    private static double? ParseDouble(string? s) =>
        !string.IsNullOrWhiteSpace(s) &&
        double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v)
            ? v
            : null;

    private static int? ParseInt(string? s) =>
        !string.IsNullOrWhiteSpace(s) &&
        int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var v)
            ? v
            : null;
}
