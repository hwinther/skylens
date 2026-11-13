namespace Skylens.Api.Options;

/// <summary>
///     Bundled offline landmarks gazetteer for the AR identify feature, built by
///     <c>data/landmarks/extract-geonames-landmarks.mjs</c> from GeoNames (CC BY 4.0) and committed as
///     <c>data/landmarks/landmarks.csv.gz</c>: peaks in Norway, Sweden and Finland plus populated places
///     (all of Norway's, larger ones abroad). Loaded once in the background at startup — no runtime upstream
///     calls. The image bakes the file at <c>/app/data/landmarks.csv.gz</c> and sets
///     <c>Landmarks__LandmarksPath</c> to it, so preview/e2e (Development) containers get the real data too;
///     local <c>dotnet run</c> (Development) reads the committed file in the repo.
/// </summary>
public sealed class LandmarksOptions
{
    public const string SectionName = "Landmarks";

    /// <summary><c>id;kind;name;lat;lon;ele;pop;iso</c> rows, optionally gzipped (<c>.gz</c>).</summary>
    public string LandmarksPath { get; set; } = "/app/data/landmarks.csv.gz";
}
