namespace Skylens.Api.Ingest;

/// <summary>Whether a decoded AIS target is a vessel or an aid-to-navigation (AtoN).</summary>
public enum VesselKind
{
    Ship,
    Aton,
}

/// <summary>
///     A single decoded AIS message parsed from one AIS-catcher JSON_FULL record on <c>ais/data</c>.
///     All fields except <see cref="Mmsi" /> and <see cref="Kind" /> are nullable — any one AIS message
///     carries only a slice of a target's picture (position, Class A voyage, Class B static, AtoN…), and
///     the store merges non-null fields across successive messages. Mirrors <see cref="AircraftUpdate" />.
/// </summary>
public sealed record VesselUpdate
{
    /// <summary>Maritime Mobile Service Identity — the store key (numeric MMSI rendered invariant).</summary>
    public required string Mmsi { get; init; }

    /// <summary>Vessel vs aid-to-navigation; set from the message type (21 = AtoN, else ship).</summary>
    public required VesselKind Kind { get; init; }

    public double? Lat { get; init; }
    public double? Lon { get; init; }

    /// <summary>Speed over ground, knots. AIS "not available" (102.3) maps to null.</summary>
    public double? Sog { get; init; }

    /// <summary>Course over ground, degrees. AIS "not available" (360) maps to null.</summary>
    public double? Cog { get; init; }

    /// <summary>True heading, degrees. AIS "not available" (511) maps to null.</summary>
    public double? Heading { get; init; }

    /// <summary>Navigation status code (Class A only), e.g. 0 = under way using engine.</summary>
    public int? NavStatus { get; init; }

    public string? NavStatusText { get; init; }

    public string? ShipName { get; init; }

    /// <summary>Ship + cargo type code (e.g. 60 = passenger).</summary>
    public int? ShipType { get; init; }

    public string? ShipTypeText { get; init; }

    public string? CallSign { get; init; }

    /// <summary>IMO number (Class A static). 0 = not supplied; carried through as-is.</summary>
    public long? Imo { get; init; }

    public string? Destination { get; init; }

    /// <summary>Estimated time of arrival — a partial "MM-DDTHH:mmZ" string, kept raw (never parsed).</summary>
    public string? Eta { get; init; }

    /// <summary>Maximum present static draught, metres.</summary>
    public double? Draught { get; init; }

    public int? DimBow { get; init; }
    public int? DimStern { get; init; }
    public int? DimPort { get; init; }
    public int? DimStarboard { get; init; }

    /// <summary>Aid-to-navigation type code (type 21 only).</summary>
    public int? AidType { get; init; }

    public string? AidTypeText { get; init; }

    /// <summary>Aid-to-navigation name (type 21 only; ships carry <see cref="ShipName" /> instead).</summary>
    public string? AtonName { get; init; }

    /// <summary>Whether the AtoN is virtual (no physical structure on the water).</summary>
    public bool? VirtualAid { get; init; }

    /// <summary>Whether the AtoN reports itself off its charted position.</summary>
    public bool? OffPosition { get; init; }

    /// <summary>ISO-ish 2-letter flag state, pre-decoded by AIS-catcher from the MMSI MID.</summary>
    public string? Flag { get; init; }

    /// <summary>The AIS message type that produced this update (1/2/3/5/18/19/21/24).</summary>
    public int MsgType { get; init; }

    public bool HasPosition => Lat.HasValue && Lon.HasValue;
}
