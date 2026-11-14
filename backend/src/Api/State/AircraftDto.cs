using System.Text.Json.Serialization;

namespace Skylens.Api.State;

/// <summary>
///     The slim, ~140-byte-per-aircraft wire DTO pushed to clients (never the raw dump1090 blob).
///     Short property names keep cellular payloads small: flight=callsign, fl=flight level (hundreds
///     of feet), gs=ground speed, trk=track, vr=vertical rate, cat=category, src=data source
///     ("adsb" own feed / "adsbx" away). seen = seconds since any message; seenPos = seconds since the
///     last position (what dead reckoning and the simulator time the position by). t = ICAO type
///     designator (e.g. "B738"), which the app turns into a readable name / aeroplane-vs-helicopter icon
///     from its own bundled type table.
/// </summary>
public sealed record AircraftDto
{
    public required string Hex { get; init; }
    public string? Flight { get; init; }
    public int? Fl { get; init; }
    public double? Lat { get; init; }
    public double? Lon { get; init; }
    public int? Alt { get; init; }
    public double? Gs { get; init; }
    public double? Trk { get; init; }
    public int? Vr { get; init; }
    public double? Seen { get; init; }
    public double? SeenPos { get; init; }
    public string? Cat { get; init; }

    /// <summary>
    ///     True for a military airframe (tar1090-db flag / readsb dbFlags), else omitted from the JSON
    ///     entirely, so the snapshot payload only grows for the few aircraft that carry it.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Mil { get; init; }

    /// <summary>
    ///     ICAO type designator ("B738", "EC35") from the offline aircraft DB (own feed) or the aggregator's
    ///     own <c>t</c> field (away mode); omitted when unknown. About 11 bytes per aircraft on the wire.
    /// </summary>
    [JsonPropertyName("t")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Type { get; init; }

    public string Src { get; init; } = "adsb";

    public static AircraftDto FromState(AircraftState s, string src = "adsb", bool military = false, string? type = null) => new()
    {
        Hex = s.Hex,
        Flight = s.Flight,
        // Flight level = barometric altitude in hundreds of feet (matches the app + demo feed).
        Fl = s.AltBaro is { } altFt ? (int)Math.Round(altFt / 100.0) : null,
        Lat = s.Lat,
        Lon = s.Lon,
        Alt = s.AltBaro,
        Gs = s.GroundSpeed,
        Trk = s.Track,
        Vr = s.BaroRate,
        Seen = s.Seen,
        SeenPos = s.SeenPos,
        Cat = s.Category,
        Mil = military ? true : null,
        Type = type,
        Src = src,
    };
}
