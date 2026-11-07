using Skylens.Api.Enrichment;
using Xunit;

namespace Skylens.Api.Tests;

/// <summary>
///     Exercises <see cref="PortDbService" />: the extractor's <c>id;kind;name;lat;lon</c> format (unnamed
///     places, unknown kinds and malformed rows) and <see cref="PortDbService.Nearby" /> radius, ordering
///     and limit. The endpoint (401 anon / 200 authed with attribution) is covered in <see cref="SmokeTests" />.
/// </summary>
public sealed class PortDbServiceTests
{
    private const string Rows = """
        n1;ferry;Oslo Vippetangen;59.90370;10.74374
        w2;marina;;59.90388;10.70007
        n3;lighthouse;Not a port;59.9;10.7
        n4;port;Broken;not-a-number;10.7
        n5;port
        r6;port;Sjursøya;59.88500;10.76000
        n7;harbour;Far away;69.65;18.95
        """;

    [Fact]
    public void Parse_keeps_known_kinds_maps_blank_names_to_null_and_skips_malformed_rows()
    {
        var ports = PortDbService.Parse(new StringReader(Rows));

        Assert.Equal(["n1", "w2", "r6", "n7"], ports.Select(p => p.Id));
        Assert.Null(ports.Single(p => p.Id == "w2").Name);
        Assert.Equal("ferry", ports[0].Kind);
        Assert.Equal(59.9037, ports[0].Lat, 4);
    }

    [Fact]
    public void Nearby_filters_by_radius_orders_nearest_first_and_caps_at_the_limit()
    {
        var db = new PortDbService(
            Microsoft.Extensions.Options.Options.Create(new Skylens.Api.Options.PortsOptions()),
            new FakeHostEnvironment(),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<PortDbService>.Instance);
        var path = Path.Combine(Path.GetTempPath(), $"ports-{Guid.NewGuid():N}.csv");
        File.WriteAllText(path, Rows);
        try
        {
            db.Load(path);

            // From the Vippetangen quay: itself first, then Sjursøya (~2.3 km), then the marina (~2.4 km);
            // the Tromsø harbour is far out of range.
            Assert.Equal(["n1", "r6", "w2"], db.Nearby(59.9037, 10.7437, 20, 10).Select(p => p.Id));
            Assert.Equal(["n1", "r6"], db.Nearby(59.9037, 10.7437, 20, 2).Select(p => p.Id));
            Assert.Empty(db.Nearby(59.9037, 10.7437, 20, 0));
        }
        finally
        {
            File.Delete(path);
        }
    }

    private sealed class FakeHostEnvironment : Microsoft.Extensions.Hosting.IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Testing";
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } =
            new Microsoft.Extensions.FileProviders.NullFileProvider();
    }
}
