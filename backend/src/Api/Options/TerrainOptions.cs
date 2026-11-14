namespace Skylens.Api.Options;

/// <summary>
///     Bundled offline elevation grids for the tiltable Radar's simplified relief, built by
///     <c>data/terrain/build-etopo-terrain.mjs</c> from ETOPO 2022 (NOAA NCEI, public domain) and committed as
///     <c>data/terrain/terrain.bin.gz</c>: a ~1 km grid over the Nordics plus a coarse 10′ global grid. Loaded
///     once in the background at startup — no runtime upstream calls. The image bakes the file at
///     <c>/app/data/terrain.bin.gz</c> and sets <c>Terrain__TerrainPath</c> to it; local <c>dotnet run</c>
///     (Development) reads the committed file in the repo.
/// </summary>
public sealed class TerrainOptions
{
    public const string SectionName = "Terrain";

    /// <summary>The builder's gzipped <c>SKYTERR1</c> binary (see the build script's header).</summary>
    public string TerrainPath { get; set; } = "/app/data/terrain.bin.gz";
}
