namespace Skylens.Api.Enrichment;

/// <summary>
///     One named landmark the AR view can identify. <c>Kind</c> is <c>peak</c>, <c>city</c>, <c>town</c>,
///     <c>village</c> or <c>hamlet</c>. <c>ElevationM</c> is set for every peak (often the SRTM cell average,
///     so it can read a little low) and for places only when the gazetteer has a surveyed value.
///     <c>Population</c> is set when known. <c>IsolationKm</c> (peaks only) is the distance to the nearest
///     higher peak in the dataset, capped at 100 km — the significance measure in place of prominence.
///     <c>Id</c> is <c>g&lt;geonameid&gt;</c>.
/// </summary>
public sealed record LandmarkDto(
    string Id,
    string Kind,
    string Name,
    double Lat,
    double Lon,
    int? ElevationM,
    int? Population,
    double? IsolationKm);

/// <summary>GET /api/landmarks response. <c>Attribution</c> must be shown wherever the landmarks are displayed.</summary>
public sealed record LandmarksResponse(DateTimeOffset FetchedAt, IReadOnlyList<LandmarkDto> Landmarks, string Attribution);
