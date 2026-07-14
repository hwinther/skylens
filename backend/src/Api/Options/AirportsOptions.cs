namespace Skylens.Api.Options;

/// <summary>
///     Bundled offline OurAirports dataset (public domain), baked into the image at build as three
///     gzipped CSVs: airports, runways, and airport frequencies. Loaded once in the background at
///     startup — no runtime upstream calls. In Development the paths point at the small test fixtures
///     (relative to the content root) instead, mirroring how <see cref="SatellitesOptions" /> swaps the
///     network for on-disk fixtures.
/// </summary>
public sealed class AirportsOptions
{
    public const string SectionName = "Airports";

    /// <summary>OurAirports <c>airports.csv[.gz]</c> — one row per airport/heliport/seaplane base.</summary>
    public string AirportsPath { get; set; } = "/app/data/airports.csv.gz";

    /// <summary>OurAirports <c>runways.csv[.gz]</c> — runway rows joined onto airports by ident.</summary>
    public string RunwaysPath { get; set; } = "/app/data/runways.csv.gz";

    /// <summary>OurAirports <c>airport-frequencies.csv[.gz]</c> — frequency rows joined by ident.</summary>
    public string FrequenciesPath { get; set; } = "/app/data/airport-frequencies.csv.gz";
}
