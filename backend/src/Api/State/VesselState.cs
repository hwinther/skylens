using Skylens.Api.Ingest;

namespace Skylens.Api.State;

/// <summary>
///     The merged, current best-known state of one AIS target (vessel or AtoN), keyed by MMSI. Successive
///     <see cref="VesselUpdate" />s merge non-null fields onto this — a position report must not blank the
///     static voyage data and vice versa; <see cref="LastSeenUtc" /> drives TTL eviction. Mirrors
///     <see cref="AircraftState" />.
/// </summary>
public sealed class VesselState
{
    public required string Mmsi { get; init; }

    public VesselKind Kind { get; set; }
    public double? Lat { get; set; }
    public double? Lon { get; set; }
    public double? Sog { get; set; }
    public double? Cog { get; set; }
    public double? Heading { get; set; }
    public int? NavStatus { get; set; }
    public string? NavStatusText { get; set; }
    public string? ShipName { get; set; }
    public int? ShipType { get; set; }
    public string? ShipTypeText { get; set; }
    public string? CallSign { get; set; }
    public long? Imo { get; set; }
    public string? Destination { get; set; }
    public string? Eta { get; set; }
    public double? Draught { get; set; }
    public int? DimBow { get; set; }
    public int? DimStern { get; set; }
    public int? DimPort { get; set; }
    public int? DimStarboard { get; set; }
    public int? AidType { get; set; }
    public string? AidTypeText { get; set; }
    public string? AtonName { get; set; }
    public bool? VirtualAid { get; set; }
    public bool? OffPosition { get; set; }
    public string? Flag { get; set; }

    /// <summary>Wall-clock time we last applied an update for this target (TTL basis).</summary>
    public DateTimeOffset LastSeenUtc { get; set; }

    public bool HasPosition => Lat.HasValue && Lon.HasValue;

    /// <summary>Merge one update in place, overwriting only the fields the update actually carries.</summary>
    public void Merge(VesselUpdate u, DateTimeOffset now)
    {
        // Kind is always known on an update (21 = AtoN, else ship) and never flips for a given MMSI.
        Kind = u.Kind;
        if (u.Lat.HasValue) Lat = u.Lat;
        if (u.Lon.HasValue) Lon = u.Lon;
        if (u.Sog.HasValue) Sog = u.Sog;
        if (u.Cog.HasValue) Cog = u.Cog;
        if (u.Heading.HasValue) Heading = u.Heading;
        if (u.NavStatus.HasValue) NavStatus = u.NavStatus;
        if (u.NavStatusText is not null) NavStatusText = u.NavStatusText;
        if (u.ShipName is not null) ShipName = u.ShipName;
        if (u.ShipType.HasValue) ShipType = u.ShipType;
        if (u.ShipTypeText is not null) ShipTypeText = u.ShipTypeText;
        if (u.CallSign is not null) CallSign = u.CallSign;
        if (u.Imo.HasValue) Imo = u.Imo;
        if (u.Destination is not null) Destination = u.Destination;
        if (u.Eta is not null) Eta = u.Eta;
        if (u.Draught.HasValue) Draught = u.Draught;
        if (u.DimBow.HasValue) DimBow = u.DimBow;
        if (u.DimStern.HasValue) DimStern = u.DimStern;
        if (u.DimPort.HasValue) DimPort = u.DimPort;
        if (u.DimStarboard.HasValue) DimStarboard = u.DimStarboard;
        if (u.AidType.HasValue) AidType = u.AidType;
        if (u.AidTypeText is not null) AidTypeText = u.AidTypeText;
        if (u.AtonName is not null) AtonName = u.AtonName;
        if (u.VirtualAid.HasValue) VirtualAid = u.VirtualAid;
        if (u.OffPosition.HasValue) OffPosition = u.OffPosition;
        if (u.Flag is not null) Flag = u.Flag;
        LastSeenUtc = now;
    }

    public static VesselState FromUpdate(VesselUpdate u, DateTimeOffset now)
    {
        var s = new VesselState { Mmsi = u.Mmsi };
        s.Merge(u, now);
        return s;
    }
}
