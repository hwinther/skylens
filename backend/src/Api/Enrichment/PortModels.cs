namespace Skylens.Api.Enrichment;

/// <summary>
///     One harbour-like place. <c>Kind</c> is <c>port</c> (commercial port / port area), <c>harbour</c>,
///     <c>marina</c> (leisure / guest harbour) or <c>ferry</c> (ferry terminal / quay). <c>Name</c> is null
///     for unnamed places. <c>Id</c> is the OSM element (<c>n123</c> / <c>w456</c> / <c>r789</c>) or
///     <c>wpi&lt;number&gt;</c> for a World Port Index entry.
/// </summary>
public sealed record PortDto(string Id, string Kind, string? Name, double Lat, double Lon);

/// <summary>GET /api/ports response. <c>Attribution</c> must be shown wherever the ports are displayed.</summary>
public sealed record PortsResponse(DateTimeOffset FetchedAt, IReadOnlyList<PortDto> Ports, string Attribution);
