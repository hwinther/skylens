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
