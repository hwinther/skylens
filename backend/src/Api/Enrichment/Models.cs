using Skylens.Api.State;

namespace Skylens.Api.Enrichment;

/// <summary>Static metadata for an aircraft (from the offline DB or OpenSky fallback).</summary>
public sealed record AircraftMetadata
{
    public required string Hex { get; init; }
    public string? Registration { get; init; }

    /// <summary>ICAO type designator, e.g. "B738".</summary>
    public string? TypeCode { get; init; }

    /// <summary>Human-readable type/model, e.g. "BOEING 737-800".</summary>
    public string? TypeName { get; init; }

    public string? Operator { get; init; }

    /// <summary>Where this metadata came from: "db" (offline) or "opensky".</summary>
    public string Source { get; init; } = "db";
}

/// <summary>A resolved flight route (origin/destination) for a callsign.</summary>
public sealed record FlightRoute
{
    public required string Ident { get; init; }
    public string? OriginIcao { get; init; }
    public string? OriginName { get; init; }
    public string? DestinationIcao { get; init; }
    public string? DestinationName { get; init; }
    public string Source { get; init; } = "aeroapi";
}

/// <summary>
///     Static, slow-changing metadata for one AIS target — the voyage/identity fields NOT carried on the
///     slim <see cref="VesselDto" />. For now it is derived straight from the merged <see cref="VesselState" />
///     (<see cref="Source" /> = "ais"); Phase 5 will additively enrich it from BarentsWatch (extra fields +
///     a different <see cref="Source" />). Mirrors <see cref="AircraftMetadata" />.
/// </summary>
public sealed record VesselMetadata
{
    public required string Mmsi { get; init; }

    /// <summary>ISO-ish 2-letter flag state (decoded from the MMSI MID).</summary>
    public string? Flag { get; init; }

    public string? CallSign { get; init; }

    /// <summary>IMO number (Class A static); 0 = not supplied, carried through as-is.</summary>
    public long? Imo { get; init; }

    public string? Destination { get; init; }

    /// <summary>Estimated time of arrival — a partial "MM-DDTHH:mmZ" string, kept raw.</summary>
    public string? Eta { get; init; }

    /// <summary>Maximum present static draught, metres.</summary>
    public double? Draught { get; init; }

    /// <summary>Human-readable ship + cargo type (e.g. "Passenger").</summary>
    public string? ShipTypeText { get; init; }

    public int? DimBow { get; init; }
    public int? DimStern { get; init; }
    public int? DimPort { get; init; }
    public int? DimStarboard { get; init; }

    /// <summary>Where this metadata came from: "ais" (derived from the live feed) for now.</summary>
    public string Source { get; init; } = "ais";

    public static VesselMetadata FromState(VesselState s) => new()
    {
        Mmsi = s.Mmsi,
        Flag = s.Flag,
        CallSign = s.CallSign,
        Imo = s.Imo,
        Destination = s.Destination,
        Eta = s.Eta,
        Draught = s.Draught,
        ShipTypeText = s.ShipTypeText,
        DimBow = s.DimBow,
        DimStern = s.DimStern,
        DimPort = s.DimPort,
        DimStarboard = s.DimStarboard,
    };
}
