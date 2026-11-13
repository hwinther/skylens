using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Skylens.Api.Enrichment;
using Skylens.Api.Options;
using Xunit;

namespace Skylens.Api.Tests;

/// <summary>
///     Exercises <see cref="LandmarkDbService" /> against the small <c>fixtures/landmarks.csv</c> (the
///     extractor's <c>id;kind;name;lat;lon;ele;pop;iso</c> format with a few broken rows mixed in): parsing,
///     the radius filter with the per-kind place ranges, nearest-first ordering and the result cap. The
///     endpoint (401 anon / 200 authed with attribution / 400 on bad coordinates) is in <see cref="SmokeTests" />.
/// </summary>
public sealed class LandmarkDbServiceTests
{
    private static readonly string Fixture = Path.Combine(AppContext.BaseDirectory, "fixtures", "landmarks.csv");

    // Oslo city centre (the fixture's "Oslo" row).
    private const double Lat = 59.9127;
    private const double Lon = 10.7461;

    private static LandmarkDbService LoadFixture()
    {
        var db = new LandmarkDbService(
            Microsoft.Extensions.Options.Options.Create(new LandmarksOptions { LandmarksPath = Fixture }),
            new FakeHostEnvironment(),
            NullLogger<LandmarkDbService>.Instance);
        db.Load(Fixture);
        return db;
    }

    [Fact]
    public void Parse_keeps_valid_rows_and_skips_unknown_kinds_blank_names_peaks_without_elevation_and_malformed_rows()
    {
        using var reader = new StreamReader(Fixture);
        var all = LandmarkDbService.Parse(reader);

        Assert.Equal(["g8436263", "g3143244", "g3159016", "g100", "g101", "g102", "g108"], all.Select(l => l.Id));

        var gausta = all[0];
        Assert.Equal("peak", gausta.Kind);
        Assert.Equal("Gaustatoppen", gausta.Name);
        Assert.Equal(1849, gausta.ElevationM);
        Assert.Null(gausta.Population);
        Assert.Equal(96.9, gausta.IsolationKm);

        var oslo = all[1];
        Assert.Equal("city", oslo.Kind);
        Assert.Equal(1082575, oslo.Population);
        Assert.Null(oslo.ElevationM);
        Assert.Null(oslo.IsolationKm);
        Assert.Equal(59.9127, oslo.Lat, 4);
    }

    [Fact]
    public void Parse_drops_isolation_on_places_and_non_positive_populations()
    {
        var rows = """
            g1;town;Somewhere;60;10;;0;12.5
            g2;peak;Top;60;10;800;;-1
            """;
        var all = LandmarkDbService.Parse(new StringReader(rows));

        Assert.Null(all[0].Population);
        Assert.Null(all[0].IsolationKm);
        Assert.Null(all[1].IsolationKm);
    }

    [Fact]
    public void Nearby_filters_by_radius_and_place_range_and_orders_nearest_first()
    {
        var db = LoadFixture();
        Assert.True(db.Loaded);
        Assert.Equal(7, db.Count);

        // Far Village is ~43 km out: inside the radius, but beyond the 25 km village range. Gaustatoppen
        // (~117 km) is a peak, so only the radius bounds it.
        Assert.Equal(
            ["g3143244", "g100", "g108", "g102", "g3159016", "g8436263"],
            db.Nearby(Lat, Lon, 150, 100).Select(l => l.Id));

        Assert.Equal(["g3143244", "g100", "g108", "g102"], db.Nearby(Lat, Lon, 20, 100).Select(l => l.Id));
    }

    [Fact]
    public void Nearby_caps_at_the_limit_and_is_empty_for_a_zero_limit_or_before_loading()
    {
        var db = LoadFixture();

        Assert.Equal(["g3143244", "g100"], db.Nearby(Lat, Lon, 150, 2).Select(l => l.Id));
        Assert.Empty(db.Nearby(Lat, Lon, 150, 0));

        var empty = new LandmarkDbService(
            Microsoft.Extensions.Options.Options.Create(new LandmarksOptions()),
            new FakeHostEnvironment(),
            NullLogger<LandmarkDbService>.Instance);
        Assert.Empty(empty.Nearby(Lat, Lon, 150, 100));
    }

    [Fact]
    public void Load_of_a_missing_file_leaves_the_service_empty_and_unloaded()
    {
        var db = new LandmarkDbService(
            Microsoft.Extensions.Options.Options.Create(new LandmarksOptions()),
            new FakeHostEnvironment(),
            NullLogger<LandmarkDbService>.Instance);

        db.Load(Path.Combine(Path.GetTempPath(), $"missing-{Guid.NewGuid():N}.csv.gz"));

        Assert.False(db.Loaded);
        Assert.Equal(0, db.Count);
    }

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Testing";
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
