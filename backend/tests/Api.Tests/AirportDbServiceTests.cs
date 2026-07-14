using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Skylens.Api.Enrichment;
using Skylens.Api.Options;
using Xunit;

namespace Skylens.Api.Tests;

/// <summary>
///     Exercises <see cref="AirportDbService" />: the RFC-4180 quoted-field splitter, header-name column
///     mapping, the airport/runway/frequency filters + join, and the <see cref="AirportDbService.Nearby" />
///     radius/ordering/limit. The service load is driven from the tiny CSV fixtures copied next to the test
///     binary; the endpoint (401 anon / 200 authed) is covered in <see cref="SmokeTests" />.
/// </summary>
public sealed class AirportDbServiceTests
{
    private static readonly string FixtureDir = Path.Combine(AppContext.BaseDirectory, "fixtures");

    // -- CSV field splitter --------------------------------------------------------------------------

    [Fact]
    public void SplitCsvLine_keeps_commas_inside_quotes_and_unescapes_doubled_quotes()
    {
        var fields = AirportDbService.SplitCsvLine("""1,"Somewhere, ""Nice"" Field",foo,""");

        Assert.Equal(4, fields.Count);
        Assert.Equal("1", fields[0]);
        Assert.Equal("Somewhere, \"Nice\" Field", fields[1]); // comma + doubled-quote escape survive
        Assert.Equal("foo", fields[2]);
        Assert.Equal("", fields[3]); // trailing empty field is kept
    }

    // -- Parsing (static, from a TextReader) ---------------------------------------------------------

    [Fact]
    public void ParseAirports_applies_type_filter_and_parses_quoted_comma_name()
    {
        using var reader = new StringReader(
            "\"ident\",\"type\",\"name\",\"latitude_deg\",\"longitude_deg\",\"elevation_ft\",\"municipality\",\"iata_code\"\n" +
            "ENCN,medium_airport,\"Kristiansand Airport\",58.2,8.08,57,Kristiansand,KRS\n" +
            "ENQC,small_airport,\"Somewhere, \"\"Nice\"\" Field\",58.1,8.0,120,Testville,\n" +
            "ENXX,closed,\"Old Closed Field\",58.3,8.2,10,Nowhere,\n" +
            "ENBP,balloonport,\"Balloon Field\",58.4,8.4,5,Nowhere,\n");

        var airports = AirportDbService.ParseAirports(
            reader,
            new Dictionary<string, List<RunwayDto>>(StringComparer.Ordinal),
            new Dictionary<string, List<AirportFrequencyDto>>(StringComparer.Ordinal));

        // closed + balloonport dropped; the two kept types remain.
        Assert.Equal(2, airports.Length);

        var encn = Assert.Single(airports, a => a.Ident == "ENCN");
        Assert.Equal("KRS", encn.Iata);
        Assert.Equal("medium_airport", encn.Type);
        Assert.Equal(57, encn.ElevationFt);
        Assert.Equal("Kristiansand", encn.Municipality);
        Assert.Equal(58.2, encn.Lat, 5);

        var enqc = Assert.Single(airports, a => a.Ident == "ENQC");
        Assert.Equal("Somewhere, \"Nice\" Field", enqc.Name); // quoted comma + "" escape parsed intact
        Assert.Null(enqc.Iata); // empty iata → null
    }

    [Fact]
    public void ParseAirports_skips_rows_missing_coordinates_and_column_order_is_by_header()
    {
        // Columns deliberately reordered vs. the real file to prove header-name (not positional) mapping.
        using var reader = new StringReader(
            "\"name\",\"latitude_deg\",\"ident\",\"type\",\"longitude_deg\"\n" +
            "Has Coords,58.2,ENAA,small_airport,8.0\n" +
            "No Lat,,ENBB,small_airport,8.0\n");

        var airports = AirportDbService.ParseAirports(
            reader,
            new Dictionary<string, List<RunwayDto>>(StringComparer.Ordinal),
            new Dictionary<string, List<AirportFrequencyDto>>(StringComparer.Ordinal));

        var a = Assert.Single(airports);
        Assert.Equal("ENAA", a.Ident);
        Assert.Equal("Has Coords", a.Name);
        Assert.Equal(8.0, a.Lon, 5);
    }

    [Fact]
    public void ParseRunways_drops_closed_and_keeps_a_runway_with_blank_high_end_coords()
    {
        using var reader = new StringReader(
            "\"airport_ident\",\"length_ft\",\"surface\",\"closed\",\"le_ident\",\"le_latitude_deg\",\"le_longitude_deg\",\"he_ident\",\"he_latitude_deg\",\"he_longitude_deg\"\n" +
            "ENCN,6677,ASP,0,03,58.196,8.075,21,58.211,8.095\n" +
            "ENCN,4000,ASP,1,09,58.20,8.07,27,58.20,8.10\n" +   // closed → dropped
            "ENGK,3000,ASP,0,12,58.515,8.695,30,,\n");           // he coords blank → kept, coords null

        var map = AirportDbService.ParseRunways(reader);

        var encn = Assert.Single(map["ENCN"]); // only the open one survives
        Assert.Equal(6677, encn.LengthFt);
        Assert.Equal("ASP", encn.Surface);
        Assert.Equal(58.196, encn.LeLat!.Value, 3);
        Assert.Equal(8.095, encn.HeLon!.Value, 3);

        var engk = Assert.Single(map["ENGK"]);
        Assert.Equal("12", engk.LeIdent);
        Assert.Equal(58.515, engk.LeLat!.Value, 3);
        Assert.Null(engk.HeLat); // blank high-end coords → null (no drawable segment)
        Assert.Null(engk.HeLon);
    }

    [Fact]
    public void ParseFrequencies_parses_mhz_with_invariant_decimal_point()
    {
        using var reader = new StringReader(
            "\"airport_ident\",\"type\",\"description\",\"frequency_mhz\"\n" +
            "ENCN,TWR,Kristiansand Tower,118.1\n" +
            "ENCN,ATIS,Kristiansand ATIS,124.475\n");

        var map = AirportDbService.ParseFrequencies(reader);

        var freqs = map["ENCN"];
        Assert.Equal(2, freqs.Count);
        Assert.Equal(118.1, Assert.Single(freqs, f => f.Type == "TWR").Mhz, 3);
        Assert.Equal(124.475, Assert.Single(freqs, f => f.Type == "ATIS").Mhz, 3);
    }

    // -- Load from the fixtures + Nearby -------------------------------------------------------------

    [Fact]
    public void Load_joins_runways_and_frequencies_and_excludes_the_closed_airport()
    {
        var service = CreateService();
        service.Load(
            Path.Combine(FixtureDir, "airports.csv"),
            Path.Combine(FixtureDir, "runways.csv"),
            Path.Combine(FixtureDir, "airport-frequencies.csv"));

        Assert.True(service.Loaded);
        // ENCN + ENGK + ENOH + ENQC; ENXX (closed) excluded.
        Assert.Equal(4, service.Count);

        // Nearby is the only read surface — query a wide radius around ENCN to get them all.
        var all = service.Nearby(58.2042, 8.0854, 500, 100);
        Assert.DoesNotContain(all, a => a.Ident == "ENXX");

        var encn = Assert.Single(all, a => a.Ident == "ENCN");
        Assert.Equal("KRS", encn.Iata);
        var runway = Assert.Single(encn.Runways); // the closed runway is dropped
        Assert.Equal(6677, runway.LengthFt);
        Assert.Equal(2, encn.Frequencies.Count);
        Assert.Contains(encn.Frequencies, f => f.Type == "TWR");
        Assert.Contains(encn.Frequencies, f => f.Type == "ATIS");

        var enqc = Assert.Single(all, a => a.Ident == "ENQC");
        Assert.Equal("Somewhere, \"Nice\" Field", enqc.Name);
    }

    [Fact]
    public void Nearby_filters_by_radius_orders_nearest_first_and_caps_at_the_limit()
    {
        var service = CreateService();
        service.Load(
            Path.Combine(FixtureDir, "airports.csv"),
            Path.Combine(FixtureDir, "runways.csv"),
            Path.Combine(FixtureDir, "airport-frequencies.csv"));

        // Observer at ENCN: ENQC (~12 km) and ENGK (~55 km) are within 100 km; ENOH (Oslo, ~250 km) is not.
        var within = service.Nearby(58.204201, 8.08537, 100, 100);
        var idents = within.Select(a => a.Ident).ToArray();
        Assert.Equal(new[] { "ENCN", "ENQC", "ENGK" }, idents); // radius filter + nearest-first ordering

        // The limit caps the result to the nearest N.
        var capped = service.Nearby(58.204201, 8.08537, 100, 2);
        Assert.Equal(new[] { "ENCN", "ENQC" }, capped.Select(a => a.Ident).ToArray());
    }

    private static AirportDbService CreateService() => new(
        Microsoft.Extensions.Options.Options.Create(new AirportsOptions()),
        new FakeHostEnvironment(),
        NullLogger<AirportDbService>.Instance);

    /// <summary>Minimal host environment — <see cref="AirportDbService.Load(string, string, string)" /> takes explicit paths, so nothing here is read.</summary>
    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string ApplicationName { get; set; } = "Skylens.Api.Tests";
        public string EnvironmentName { get; set; } = "Testing";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
