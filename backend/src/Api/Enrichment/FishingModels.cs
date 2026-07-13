using System.Text.Json.Nodes;

namespace Skylens.Api.Enrichment;

/// <summary>
///     One fishing-regulation zone normalized from BarentsWatch FiskInfo into a common shape for the
///     "fishing mode" map layer. <see cref="Kind" /> is <c>"cod"</c> (coastal cod protection),
///     <c>"forbidden"</c> (forbidden fishing zone), or <c>"zero"</c> (zero fishing area).
///     <see cref="Geometry" /> is the upstream GeoJSON geometry object passed through VERBATIM (never
///     reshaped) so the client can render it directly — the type present varies by dataset
///     (LineString for cod boundaries, Polygon/MultiPolygon for forbidden/zero areas).
/// </summary>
public sealed record FishingZone(string Kind, string? Info, JsonNode? Geometry);

/// <summary>A combined set of fishing-regulation zones (cod + forbidden + zero) with its fetch time.</summary>
public sealed record FishingZones(DateTimeOffset FetchedAt, IReadOnlyList<FishingZone> Zones);

/// <summary>
///     One piece of lost/ghost fishing gear reported to BarentsWatch and not yet removed. Regular API
///     users receive ANONYMIZED data (vessel identity fields are stripped upstream), so only the gear
///     type/count, loss time/cause, source, and point <see cref="Geometry" /> (GeoJSON, verbatim) survive.
/// </summary>
public sealed record LostGear(
    string? ToolTypeCode,
    int? Count,
    DateTimeOffset? LostTime,
    string? LostCause,
    string? Source,
    JsonNode? Geometry);

/// <summary>
///     Basic NOR/NIS ship-register info for one MMSI from FiskInfo <c>/v2/shipregister/{mmsi}</c>. The
///     register carries no home-port field; the registered <see cref="Owner" /> (organisation name) and
///     the vessel-type description are the closest identity/enrichment fields it provides.
/// </summary>
public sealed record ShipRegister(
    string Mmsi,
    long? Imo,
    string? CallSign,
    string? Name,
    string? RegNo,
    string? VesselType,
    string? Owner,
    double? LengthOverall,
    double? GrossTonnage,
    bool Registered);
