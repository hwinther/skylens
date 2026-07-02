using Skylens.Api.Ingest;

namespace Skylens.Api.State;

/// <summary>
///     The merged, current best-known state of one aircraft. Successive <see cref="AircraftUpdate" />s
///     merge non-null fields onto this; <see cref="LastSeenUtc" /> drives TTL eviction.
/// </summary>
public sealed class AircraftState
{
    public required string Hex { get; init; }

    public string? Flight { get; set; }
    public double? Lat { get; set; }
    public double? Lon { get; set; }
    public int? AltBaro { get; set; }
    public bool OnGround { get; set; }
    public double? GroundSpeed { get; set; }
    public double? Track { get; set; }
    public int? BaroRate { get; set; }
    public string? Category { get; set; }
    public double? Seen { get; set; }
    public double? SeenPos { get; set; }

    /// <summary>Wall-clock time we last applied an update for this aircraft (TTL basis).</summary>
    public DateTimeOffset LastSeenUtc { get; set; }

    public bool HasPosition => Lat.HasValue && Lon.HasValue;

    /// <summary>Merge one update in place, overwriting only the fields the update actually carries.</summary>
    public void Merge(AircraftUpdate u, DateTimeOffset now)
    {
        if (u.Flight is not null) Flight = u.Flight;
        if (u.Lat.HasValue) Lat = u.Lat;
        if (u.Lon.HasValue) Lon = u.Lon;
        if (u.AltBaro.HasValue) AltBaro = u.AltBaro;
        if (u.AltBaro.HasValue || u.OnGround) OnGround = u.OnGround;
        if (u.GroundSpeed.HasValue) GroundSpeed = u.GroundSpeed;
        if (u.Track.HasValue) Track = u.Track;
        if (u.BaroRate.HasValue) BaroRate = u.BaroRate;
        if (u.Category is not null) Category = u.Category;
        if (u.Seen.HasValue) Seen = u.Seen;
        if (u.SeenPos.HasValue) SeenPos = u.SeenPos;
        LastSeenUtc = now;
    }

    public static AircraftState FromUpdate(AircraftUpdate u, DateTimeOffset now)
    {
        var s = new AircraftState { Hex = u.Hex };
        s.Merge(u, now);
        return s;
    }
}
