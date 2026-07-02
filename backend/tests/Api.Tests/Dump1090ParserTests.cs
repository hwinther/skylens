using Xunit;
using Skylens.Api.Ingest;

namespace Skylens.Api.Tests;

public sealed class Dump1090ParserTests
{
    // Deterministic parser-contract assertions run against the synthetic fixture, which is hand-built
    // to exercise the parser gotchas and never changes. The real capture (aircraft.json) is covered by
    // Dump1090ParserRealCaptureTests with structural assertions only.
    private static string FixtureJson() =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "aircraft-synthetic.json"));

    [Fact]
    public void Parse_reads_now_and_all_aircraft_from_fixture()
    {
        var (now, aircraft) = Dump1090Parser.Parse(FixtureJson());

        Assert.Equal(1719878400.5, now);
        Assert.Equal(6, aircraft.Count);
    }

    [Fact]
    public void Parse_trims_space_padded_flight()
    {
        var (_, aircraft) = Dump1090Parser.Parse(FixtureJson());

        var ryr = aircraft.Single(a => a.Hex == "4ca7b5");
        Assert.Equal("RYR4TZ", ryr.Flight);
    }

    [Fact]
    public void Parse_maps_ground_string_to_onground_and_null_altitude()
    {
        var (_, aircraft) = Dump1090Parser.Parse(FixtureJson());

        var wif = aircraft.Single(a => a.Hex == "471f8d");
        Assert.True(wif.OnGround);
        Assert.Null(wif.AltBaro);
    }

    [Fact]
    public void Parse_keeps_positionless_aircraft_without_lat_lon()
    {
        var (_, aircraft) = Dump1090Parser.Parse(FixtureJson());

        var sas = aircraft.Single(a => a.Hex == "45ac52");
        Assert.False(sas.HasPosition);
        Assert.Null(sas.Lat);
        Assert.Null(sas.Lon);
        Assert.Equal(4275, sas.AltBaro);
    }

    [Fact]
    public void Parse_handles_missing_flight_field()
    {
        var (_, aircraft) = Dump1090Parser.Parse(FixtureJson());

        var noCallsign = aircraft.Single(a => a.Hex == "4b1615");
        Assert.Null(noCallsign.Flight);
        Assert.True(noCallsign.HasPosition);
    }

    [Fact]
    public void Parse_reads_float_seen_and_seen_pos()
    {
        var (_, aircraft) = Dump1090Parser.Parse(FixtureJson());

        var ryr = aircraft.Single(a => a.Hex == "4ca7b5");
        Assert.Equal(0.1, ryr.Seen);
        Assert.Equal(0.4, ryr.SeenPos);
    }

    [Fact]
    public void Parse_preserves_tilde_prefixed_non_icao_address()
    {
        var (_, aircraft) = Dump1090Parser.Parse(FixtureJson());

        Assert.Contains(aircraft, a => a.Hex == "~a3b1c2");
    }

    [Fact]
    public void Parse_skips_bad_entries_without_throwing()
    {
        const string json = """
            { "now": 1.0, "aircraft": [ 42, {"hex":""}, {"noHex":true}, {"hex":"abc123","gs":100} ] }
            """;

        var (_, aircraft) = Dump1090Parser.Parse(json);

        var only = Assert.Single(aircraft);
        Assert.Equal("abc123", only.Hex);
    }

    [Fact]
    public void Parse_empty_object_returns_no_aircraft()
    {
        var (now, aircraft) = Dump1090Parser.Parse("{}");

        Assert.Null(now);
        Assert.Empty(aircraft);
    }
}
