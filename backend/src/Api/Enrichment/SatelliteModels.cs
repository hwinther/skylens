using System.Text.Json.Serialization;

namespace Skylens.Api.Enrichment;

/// <summary>
///     A CelesTrak OMM (Orbit Mean-Elements Message) record, one satellite's Keplerian element set.
///     Field names are the VERBATIM uppercase CelesTrak/OMM keys so the record round-trips byte-for-byte:
///     the app feeds this JSON straight into satellite.js's <c>json2satrec</c> to build an SGP4
///     propagator. Numbers stay numbers; <see cref="ObjectName" />/<see cref="ObjectId" />/
///     <see cref="Epoch" />/<see cref="ClassificationType" /> stay strings.
/// </summary>
public sealed record OmmElements(
    [property: JsonPropertyName("OBJECT_NAME")] string ObjectName,
    [property: JsonPropertyName("OBJECT_ID")] string ObjectId,
    [property: JsonPropertyName("EPOCH")] string Epoch,
    [property: JsonPropertyName("MEAN_MOTION")] double MeanMotion,
    [property: JsonPropertyName("ECCENTRICITY")] double Eccentricity,
    [property: JsonPropertyName("INCLINATION")] double Inclination,
    [property: JsonPropertyName("RA_OF_ASC_NODE")] double RaOfAscNode,
    [property: JsonPropertyName("ARG_OF_PERICENTER")] double ArgOfPericenter,
    [property: JsonPropertyName("MEAN_ANOMALY")] double MeanAnomaly,
    [property: JsonPropertyName("EPHEMERIS_TYPE")] int EphemerisType,
    [property: JsonPropertyName("CLASSIFICATION_TYPE")] string ClassificationType,
    [property: JsonPropertyName("NORAD_CAT_ID")] int NoradCatId,
    [property: JsonPropertyName("ELEMENT_SET_NO")] int ElementSetNo,
    [property: JsonPropertyName("REV_AT_EPOCH")] int RevAtEpoch,
    [property: JsonPropertyName("BSTAR")] double BStar,
    [property: JsonPropertyName("MEAN_MOTION_DOT")] double MeanMotionDot,
    [property: JsonPropertyName("MEAN_MOTION_DDOT")] double MeanMotionDdot);

/// <summary>
///     App-facing satellite record: identity + orbital elements + an optional human-readable downlink
///     summary from SatNOGS. <see cref="Group" /> is one of "stations" | "amateur" | "weather" | "gnss"
///     (the four CelesTrak GNSS constellations gps-ops/galileo/glo-ops/beidou collapse to "gnss").
/// </summary>
public sealed record SatelliteDto(int NoradId, string Name, string Group, string? FreqSummary, OmmElements Omm);

/// <summary>
///     One SatNOGS transmitter for a satellite. Frequencies are in Hz (as SatNOGS reports them);
///     <see cref="Alive" /> + <see cref="Status" /> together mark whether the transmitter is currently
///     operational (an active downlink drives <see cref="SatelliteDto.FreqSummary" />).
/// </summary>
public sealed record SatelliteTransmitterDto(
    string? Description,
    string? Type,
    long? DownlinkLowHz,
    long? DownlinkHighHz,
    long? UplinkLowHz,
    long? UplinkHighHz,
    string? Mode,
    double? Baud,
    string? Status,
    bool Alive);
