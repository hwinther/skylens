namespace Skylens.Api.Enrichment;

/// <summary>
///     GET /api/terrain response: a square elevation grid centred on (<c>Lat</c>, <c>Lon</c>) for the Radar's
///     relief. <c>Size</c> × <c>Size</c> cells of <c>CellKm</c>, row-major from the north-west corner: cell
///     (row, col) sits <c>(col − (Size−1)/2) × CellKm</c> east and <c>((Size−1)/2 − row) × CellKm</c> north of
///     the centre, measured along the great circle (distance + bearing, like the radar plots its blips).
///     <c>Heights</c> are metres above sea level rounded to 10 m; 0 is sea (or no data). <c>Size</c> is 0 when
///     the terrain DB is unavailable. <c>Attribution</c> must be shown wherever the relief is drawn.
/// </summary>
public sealed record TerrainResponse(
    DateTimeOffset FetchedAt,
    double Lat,
    double Lon,
    double RadiusKm,
    double CellKm,
    int Size,
    IReadOnlyList<int> Heights,
    string Attribution);

/// <summary>One sampled grid (see <see cref="TerrainResponse" /> for the layout).</summary>
public sealed record TerrainSample(double CellKm, int Size, int[] Heights);
