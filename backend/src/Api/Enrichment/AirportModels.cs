namespace Skylens.Api.Enrichment;

/// <summary>
///     One airport from the bundled OurAirports dataset, with its runways and frequencies joined on.
///     <see cref="Type" /> is the OurAirports class kept by the loader (<c>large_airport</c> /
///     <c>medium_airport</c> / <c>small_airport</c> / <c>heliport</c> / <c>seaplane_base</c>);
///     <c>closed</c>/<c>balloonport</c> rows and rows without coordinates are dropped at load. The client
///     computes relative position itself (as it does for everything else), so no distance is carried here.
/// </summary>
public sealed record AirportDto(
    string Ident,
    string? Iata,
    string Name,
    string Type,
    double Lat,
    double Lon,
    int? ElevationFt,
    string? Municipality,
    IReadOnlyList<RunwayDto> Runways,
    IReadOnlyList<AirportFrequencyDto> Frequencies);

/// <summary>
///     One (non-closed) runway. Length/surface are always useful; the low/high-end coordinates may be
///     absent upstream (nullable here) — the client draws a runway segment only when BOTH ends carry
///     coordinates, and otherwise falls back to the length/surface text.
/// </summary>
public sealed record RunwayDto(
    string? LeIdent,
    string? HeIdent,
    int? LengthFt,
    string? Surface,
    double? LeLat,
    double? LeLon,
    double? HeLat,
    double? HeLon);

/// <summary>
///     One airport radio frequency (an airband-SDR companion): <see cref="Type" /> is the OurAirports
///     code (e.g. <c>TWR</c>, <c>ATIS</c>, <c>GND</c>), <see cref="Description" /> its human label, and
///     <see cref="Mhz" /> the frequency in megahertz.
/// </summary>
public sealed record AirportFrequencyDto(string Type, string? Description, double Mhz);

/// <summary>A radius-filtered set of airports (nearest-first) with the dataset's load time.</summary>
public sealed record AirportsResponse(DateTimeOffset FetchedAt, IReadOnlyList<AirportDto> Airports);
