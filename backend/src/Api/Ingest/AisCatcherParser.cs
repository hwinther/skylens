using System.Globalization;
using System.Text.Json;

namespace Skylens.Api.Ingest;

/// <summary>
///     Parses one AIS-catcher JSON_FULL record (a single line of the <c>ais/data</c> stream) into a
///     <see cref="VesselUpdate" />. Handles the real-world gotchas: numbers arriving as int or float, the
///     AIS "not available" sentinels (heading 511, course 360, speed 102.3, lat/lon 91/181), the Class B
///     type-24 static report split across <c>partno</c> parts, and message types we don't track. Anything
///     it can't make sense of — malformed JSON, an untracked/base-station type, a missing MMSI — returns
///     null rather than throwing: one bad message must never break the ingest loop. Mirrors
///     <see cref="Dump1090Parser" />.
/// </summary>
public static class AisCatcherParser
{
    public static VesselUpdate? Parse(ReadOnlySpan<byte> utf8Json)
    {
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(utf8Json.ToArray());
        }
        catch (JsonException)
        {
            // Malformed / non-JSON payload — skip it, never throw.
            return null;
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return null;

            var type = GetInt(root, "type");
            if (type is null || !IsTracked(type.Value))
                return null;

            var mmsi = GetLong(root, "mmsi");
            if (mmsi is null)
                return null;

            var (lat, lon) = ParsePosition(root);

            // Read every field the union of message types can carry; each type populates only its own
            // slice (a position report has no shipname, an AtoN carries `name` not `shipname`, …), so
            // reading unconditionally is safe and keeps type-24 partno merging free — we never special
            // -case partno, just take whichever of shipname/shiptype/callsign/dims a part happens to have.
            return new VesselUpdate
            {
                Mmsi = mmsi.Value.ToString(CultureInfo.InvariantCulture),
                Kind = type.Value == 21 ? VesselKind.Aton : VesselKind.Ship,
                MsgType = type.Value,
                Lat = lat,
                Lon = lon,
                Sog = Sentinel(GetDouble(root, "speed"), 102.3),
                Cog = Sentinel(GetDouble(root, "course"), 360),
                Heading = Sentinel(GetDouble(root, "heading"), 511),
                NavStatus = GetInt(root, "status"),
                NavStatusText = GetString(root, "status_text"),
                ShipName = NonEmpty(GetString(root, "shipname")),
                ShipType = GetInt(root, "shiptype"),
                ShipTypeText = GetString(root, "shiptype_text"),
                CallSign = NonEmpty(GetString(root, "callsign")),
                Imo = GetLong(root, "imo"),
                Destination = NonEmpty(GetString(root, "destination")),
                Eta = GetString(root, "eta"),
                Draught = GetDouble(root, "draught"),
                DimBow = GetInt(root, "to_bow"),
                DimStern = GetInt(root, "to_stern"),
                DimPort = GetInt(root, "to_port"),
                DimStarboard = GetInt(root, "to_starboard"),
                AidType = GetInt(root, "aid_type"),
                AidTypeText = GetString(root, "aid_type_text"),
                AtonName = NonEmpty(GetString(root, "name")),
                VirtualAid = GetBool(root, "virtual_aid"),
                OffPosition = GetBool(root, "off_position"),
                Flag = GetString(root, "country_code"),
            };
        }
    }

    /// <summary>Convenience overload for string input (tests / fixtures).</summary>
    public static VesselUpdate? Parse(string json) =>
        Parse(System.Text.Encoding.UTF8.GetBytes(json));

    // Message types we decode into a picture. Type 4 (base station) and everything else are ignored.
    // 2 is treated exactly like 1/3; 19 like 18 (but may also carry shipname/shiptype, read above).
    private static bool IsTracked(int type) =>
        type is 1 or 2 or 3 or 5 or 18 or 19 or 21 or 24;

    /// <summary>Latitude/longitude, mapping the AIS "not available" sentinels (91 / 181) to no-position.</summary>
    private static (double? Lat, double? Lon) ParsePosition(JsonElement obj)
    {
        var lat = GetDouble(obj, "lat");
        var lon = GetDouble(obj, "lon");
        if (!lat.HasValue || !lon.HasValue || lat.Value >= 90.5 || lon.Value >= 180.5)
            return (null, null);
        return (lat, lon);
    }

    /// <summary>Null out a value at or above the AIS "not available" sentinel for that field.</summary>
    private static double? Sentinel(double? value, double sentinel) =>
        value is { } v && v < sentinel ? v : null;

    private static string? NonEmpty(string? s) => s?.Trim() is { Length: > 0 } t ? t : null;

    private static string? GetString(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String
            ? el.GetString()
            : null;

    private static double? GetDouble(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.Number &&
        el.TryGetDouble(out var d)
            ? d
            : null;

    private static int? GetInt(JsonElement obj, string name)
    {
        if (!obj.TryGetProperty(name, out var el) || el.ValueKind != JsonValueKind.Number)
            return null;
        if (el.TryGetInt32(out var i))
            return i;
        return el.TryGetDouble(out var d) ? (int)Math.Round(d) : null;
    }

    private static long? GetLong(JsonElement obj, string name)
    {
        if (!obj.TryGetProperty(name, out var el) || el.ValueKind != JsonValueKind.Number)
            return null;
        if (el.TryGetInt64(out var l))
            return l;
        return el.TryGetDouble(out var d) ? (long)Math.Round(d) : null;
    }

    private static bool? GetBool(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var el) && el.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? el.GetBoolean()
            : null;
}
