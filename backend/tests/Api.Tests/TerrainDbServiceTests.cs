using System.Buffers.Binary;
using System.IO.Compression;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Skylens.Api.Enrichment;
using Skylens.Api.Options;
using Xunit;

namespace Skylens.Api.Tests;

/// <summary>
///     Exercises <see cref="TerrainDbService" /> on small synthetic <c>SKYTERR1</c> files built in the test
///     (the build script's format, incl. the row "up" filter): parsing and its validation, the code decoding,
///     the radar resampling (layout, cell size, the size cap, sea/land majority, finest-grid-first lookup and
///     antimeridian wrap). The endpoint (401 anon / 200 authed on the committed file / 400 / clamp) is in
///     <see cref="SmokeTests" />.
/// </summary>
public sealed class TerrainDbServiceTests
{
    /// <summary>Builds the uncompressed SKYTERR1 bytes for grids given as (south, west, dLat, dLon, codes[rows, cols]).</summary>
    private static byte[] Build(params (double South, double West, double DLat, double DLon, byte[,] Codes)[] grids)
    {
        using var ms = new MemoryStream();
        ms.Write("SKYTERR1"u8);
        ms.WriteByte((byte)grids.Length);
        foreach (var (south, west, dLat, dLon, codes) in grids)
        {
            var rows = codes.GetLength(0);
            var cols = codes.GetLength(1);
            var h = new byte[40];
            BinaryPrimitives.WriteDoubleLittleEndian(h.AsSpan(0), south);
            BinaryPrimitives.WriteDoubleLittleEndian(h.AsSpan(8), west);
            BinaryPrimitives.WriteDoubleLittleEndian(h.AsSpan(16), dLat);
            BinaryPrimitives.WriteDoubleLittleEndian(h.AsSpan(24), dLon);
            BinaryPrimitives.WriteUInt32LittleEndian(h.AsSpan(32), (uint)rows);
            BinaryPrimitives.WriteUInt32LittleEndian(h.AsSpan(36), (uint)cols);
            ms.Write(h);
            for (var i = 0; i < rows; i++)
                for (var j = 0; j < cols; j++)
                    ms.WriteByte(unchecked((byte)(codes[i, j] - (i > 0 ? codes[i - 1, j] : 0))));
        }

        return ms.ToArray();
    }

    private static byte[,] Fill(int rows, int cols, Func<int, int, byte> f)
    {
        var a = new byte[rows, cols];
        for (var i = 0; i < rows; i++)
            for (var j = 0; j < cols; j++)
                a[i, j] = f(i, j);
        return a;
    }

    [Fact]
    public void Parse_reads_the_grids_and_undoes_the_row_filter()
    {
        var codes = new byte[,] { { 0, 5, 250 }, { 10, 3, 0 } };
        var grids = TerrainDbService.Parse(new MemoryStream(Build((59, 10, 0.5, 0.25, codes))));

        var g = Assert.Single(grids);
        Assert.Equal((59.0, 10.0, 0.5, 0.25, 2, 3), (g.South, g.West, g.DLat, g.DLon, g.Rows, g.Cols));
        Assert.Equal(new byte[] { 0, 5, 250, 10, 3, 0 }, g.Codes);
        Assert.False(g.WrapsLongitude);
    }

    [Fact]
    public void Parse_rejects_a_bad_magic_a_bad_header_and_a_truncated_body()
    {
        var ok = Build((59, 10, 0.5, 0.5, new byte[2, 2]));

        var badMagic = (byte[])ok.Clone();
        badMagic[0] = (byte)'X';
        Assert.Throws<InvalidDataException>(() => TerrainDbService.Parse(new MemoryStream(badMagic)));

        var badHeader = (byte[])ok.Clone();
        BinaryPrimitives.WriteDoubleLittleEndian(badHeader.AsSpan(9 + 16), -1); // dLat
        Assert.Throws<InvalidDataException>(() => TerrainDbService.Parse(new MemoryStream(badHeader)));

        Assert.Throws<InvalidDataException>(() => TerrainDbService.Parse(new MemoryStream(ok[..^1])));
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(1, 10)]
    [InlineData(200, 2000)]
    [InlineData(201, 2125)]
    [InlineData(255, 8875)]
    public void Decode_maps_codes_to_metres(int code, int metres) =>
        Assert.Equal(metres, TerrainDbService.Decode((byte)code));

    [Fact]
    public void Sample_lays_out_a_square_grid_north_west_first_with_sea_and_land()
    {
        // 0.01° cells around (60, 10): land (code 50 = 500 m) north of 60°, sea south of it.
        var codes = Fill(201, 401, (i, _) => (byte)(i >= 100 ? 50 : 0));
        var grids = TerrainDbService.Parse(new MemoryStream(Build((59, 8, 0.01, 0.01, codes))));

        var s = TerrainDbService.Sample(grids, 60.0005, 10, 50);

        Assert.Equal(129, s.Size);
        Assert.Equal(100.0 / 128, s.CellKm, 9);
        Assert.Equal(s.Size * s.Size, s.Heights.Length);
        // Row 0 is the northern edge (land), the last row the southern edge (sea).
        Assert.Equal(500, s.Heights[0]);
        Assert.Equal(0, s.Heights[(s.Size - 1) * s.Size]);
        // Every height is a multiple of 10 m.
        Assert.All(s.Heights, h => Assert.Equal(0, h % 10));
    }

    [Fact]
    public void Sample_clamps_the_radius_caps_the_size_and_keeps_a_minimum_cell()
    {
        var grids = TerrainDbService.Parse(new MemoryStream(Build((-90, -180, 1, 1, new byte[181, 360]))));

        var huge = TerrainDbService.Sample(grids, 60, 10, 5000);
        Assert.Equal(TerrainDbService.MaxCells, huge.Size);
        Assert.Equal(2 * TerrainDbService.MaxRadiusKm / (TerrainDbService.MaxCells - 1), huge.CellKm, 9);

        var tiny = TerrainDbService.Sample(grids, 60, 10, 5);
        Assert.Equal(TerrainDbService.MinCellKm, tiny.CellKm);
        Assert.Equal(21, tiny.Size); // ±10 cells of 0.5 km
    }

    [Fact]
    public void Sample_averages_a_mostly_land_cell_and_drops_a_mostly_sea_one()
    {
        // 0.05° source cells; a 250 km radius makes ~3.9 km cells sampled 3×3, so a cell straddling a
        // coast takes the land mean when most of its samples are land, else sea.
        var codes = Fill(400, 800, (i, j) => (byte)(j % 2 == 0 ? 100 : 0)); // alternating 1000 m / sea columns
        var grids = TerrainDbService.Parse(new MemoryStream(Build((50, 0, 0.05, 0.05, codes))));

        var s = TerrainDbService.Sample(grids, 60, 20, 250);

        Assert.All(s.Heights, h => Assert.True(h is 0 or 1000, $"unexpected height {h}"));
        Assert.Contains(1000, s.Heights);
        Assert.Contains(0, s.Heights);
    }

    [Fact]
    public void Lookup_prefers_the_first_grid_and_wraps_a_global_grid_at_the_antimeridian()
    {
        var fine = (59.0, 9.0, 0.1, 0.1, Fill(21, 21, (_, _) => 30)); // 300 m around (60, 10)
        var world = (-90.0, -180.0, 1.0, 1.0, Fill(181, 360, (_, j) => (byte)(j == 0 ? 7 : 1)));
        var grids = TerrainDbService.Parse(new MemoryStream(Build(fine, world)));

        Assert.Equal(300, TerrainDbService.Lookup(grids, 60, 10));
        Assert.Equal(10, TerrainDbService.Lookup(grids, 0, 50));
        // lon 180 rounds to column 360, which wraps to column 0 (= −180).
        Assert.Equal(70, TerrainDbService.Lookup(grids, 0, 180));
        Assert.True(grids[1].WrapsLongitude);
    }

    [Fact]
    public void Destination_moves_along_the_bearing()
    {
        var (lat, lon) = TerrainDbService.Destination(60, 10, 0, 111.195);
        Assert.Equal(61, lat, 2);
        Assert.Equal(10, lon, 6);

        var (lat2, lon2) = TerrainDbService.Destination(0, 179.9, Math.PI / 2, 22.239);
        Assert.Equal(0, lat2, 6);
        Assert.Equal(-179.9, lon2, 2); // across the antimeridian
    }

    [Fact]
    public void Load_reads_a_gzipped_file_and_a_missing_file_leaves_the_service_empty()
    {
        var path = Path.Combine(Path.GetTempPath(), $"terrain-{Guid.NewGuid():N}.bin.gz");
        try
        {
            using (var f = File.Create(path))
            using (var gz = new GZipStream(f, CompressionLevel.Fastest))
                gz.Write(Build((59, 9, 0.1, 0.1, Fill(21, 21, (_, _) => 30))));

            var db = NewService();
            db.Load(path);
            Assert.True(db.Loaded);
            var s = db.Sample(60, 10, 3);
            Assert.NotNull(s);
            Assert.All(s.Heights, h => Assert.Equal(300, h));

            var missing = NewService();
            missing.Load(path + ".missing");
            Assert.False(missing.Loaded);
            Assert.Null(missing.Sample(60, 10, 50));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Load_of_a_corrupt_file_logs_and_stays_empty()
    {
        var path = Path.Combine(Path.GetTempPath(), $"terrain-{Guid.NewGuid():N}.bin.gz");
        try
        {
            File.WriteAllBytes(path, [1, 2, 3]);
            var db = NewService();
            db.Load(path);
            Assert.False(db.Loaded);
        }
        finally
        {
            File.Delete(path);
        }
    }

    private static TerrainDbService NewService() =>
        new(Microsoft.Extensions.Options.Options.Create(new TerrainOptions()), new FakeHostEnvironment(),
            NullLogger<TerrainDbService>.Instance);

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Testing";
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
