using Skylens.Api.Ingest;

namespace Skylens.Api.State;

/// <summary>
///     The slim wire DTO pushed to clients for one AIS target (never the raw AIS-catcher blob). Short
///     property names keep cellular payloads small: sog=speed over ground (knots), cog=course over
///     ground, hdg=true heading, kind="ship"/"aton", flag=2-letter state, seen=seconds since the last
///     message, src=data source. Mirrors <see cref="AircraftDto" />.
/// </summary>
public sealed record VesselDto
{
    public required string Mmsi { get; init; }

    /// <summary>Ship name, or the aid-to-navigation name for an AtoN.</summary>
    public string? Name { get; init; }

    /// <summary>"ship" or "aton" (lowercase).</summary>
    public required string Kind { get; init; }

    public double? Lat { get; init; }
    public double? Lon { get; init; }
    public double? Sog { get; init; }
    public double? Cog { get; init; }
    public double? Hdg { get; init; }
    public int? ShipType { get; init; }
    public int? NavStatus { get; init; }
    public int? AidType { get; init; }

    /// <summary>
    ///     AtoN only: true = a virtual/phantom aid with no physical structure on the water (chart-only
    ///     mark). Null/absent for ships and for physical aids. Sourced from AIS message-21 <c>virtual_aid</c>.
    /// </summary>
    public bool? Virtual { get; init; }

    public string? Flag { get; init; }

    /// <summary>Seconds since the last message for this target.</summary>
    public double? Seen { get; init; }

    public string Src { get; init; } = "ais";

    public static VesselDto FromState(VesselState s, DateTimeOffset nowUtc, string src = "ais") => new()
    {
        Mmsi = s.Mmsi,
        Name = s.ShipName ?? s.AtonName,
        Kind = s.Kind == VesselKind.Aton ? "aton" : "ship",
        Lat = s.Lat,
        Lon = s.Lon,
        Sog = s.Sog,
        Cog = s.Cog,
        Hdg = s.Heading,
        ShipType = s.ShipType,
        NavStatus = s.NavStatus,
        AidType = s.AidType,
        Virtual = s.VirtualAid,
        Flag = s.Flag,
        Seen = (nowUtc - s.LastSeenUtc).TotalSeconds,
        Src = src,
    };
}
