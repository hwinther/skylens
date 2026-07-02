namespace Skylens.Api.Ingest;

/// <summary>
///     A single decoded aircraft observation parsed from one entry of dump1090-fa's aircraft.json.
///     All fields except <see cref="Hex" /> are nullable — dump1090 omits whatever it hasn't decoded
///     yet, and the store merges non-null fields across successive snapshots.
/// </summary>
public sealed record AircraftUpdate
{
    /// <summary>24-bit ICAO address, lowercase hex (the store key).</summary>
    public required string Hex { get; init; }

    /// <summary>Callsign / flight number, already trimmed of dump1090's space padding.</summary>
    public string? Flight { get; init; }

    public double? Lat { get; init; }
    public double? Lon { get; init; }

    /// <summary>Barometric altitude in feet. dump1090 emits "ground" as a string; we map that to null + <see cref="OnGround" />.</summary>
    public int? AltBaro { get; init; }

    public bool OnGround { get; init; }

    /// <summary>Ground speed, knots.</summary>
    public double? GroundSpeed { get; init; }

    /// <summary>True track over ground, degrees.</summary>
    public double? Track { get; init; }

    /// <summary>Vertical rate (barometric), ft/min.</summary>
    public int? BaroRate { get; init; }

    /// <summary>Emitter category (e.g. "A3").</summary>
    public string? Category { get; init; }

    /// <summary>Seconds since any message was received for this aircraft.</summary>
    public double? Seen { get; init; }

    /// <summary>Seconds since a position was received for this aircraft.</summary>
    public double? SeenPos { get; init; }

    public bool HasPosition => Lat.HasValue && Lon.HasValue;
}
