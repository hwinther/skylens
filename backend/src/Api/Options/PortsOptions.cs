namespace Skylens.Api.Options;

/// <summary>
///     Bundled offline ports, built by <c>data/ports/extract-osm-ports.mjs</c> and committed as
///     <c>data/ports/ports.csv.gz</c>: harbours / marinas / ferry terminals / port areas for Norway from
///     OpenStreetMap (ODbL), plus the NGA World Port Index (public domain) for the rest of the world. Loaded once in the background at startup — no runtime upstream
///     calls. The image bakes the file at <c>/app/data/ports.csv.gz</c> and sets <c>Ports__PortsPath</c>
///     to it, so preview/e2e (Development) containers get the real data too; local <c>dotnet run</c>
///     (Development) reads the committed file in the repo.
/// </summary>
public sealed class PortsOptions
{
    public const string SectionName = "Ports";

    /// <summary><c>id;kind;name;lat;lon</c> rows, optionally gzipped (<c>.gz</c>).</summary>
    public string PortsPath { get; set; } = "/app/data/ports.csv.gz";
}
