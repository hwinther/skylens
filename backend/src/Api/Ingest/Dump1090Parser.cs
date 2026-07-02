using System.Text.Json;

namespace Skylens.Api.Ingest;

/// <summary>
///     Parses a dump1090-fa aircraft.json blob into <see cref="AircraftUpdate" /> records.
///     Handles the real-world gotchas: missing fields, <c>alt_baro:"ground"</c> (string), space-padded
///     <c>flight</c>, aircraft with no position, and float <c>seen</c>/<c>seen_pos</c>. Anything it can't
///     make sense of is skipped rather than throwing — one bad entry must not drop the whole snapshot.
/// </summary>
public static class Dump1090Parser
{
    /// <summary>The <c>now</c> field of the last parsed snapshot, or null if absent.</summary>
    public static (double? Now, IReadOnlyList<AircraftUpdate> Aircraft) Parse(ReadOnlySpan<byte> utf8Json)
    {
        var result = new List<AircraftUpdate>();
        double? now = null;

        using var doc = JsonDocument.Parse(utf8Json.ToArray());
        var root = doc.RootElement;

        if (root.ValueKind != JsonValueKind.Object)
            return (null, result);

        if (root.TryGetProperty("now", out var nowEl) && nowEl.ValueKind == JsonValueKind.Number)
            now = nowEl.GetDouble();

        if (!root.TryGetProperty("aircraft", out var aircraftEl) ||
            aircraftEl.ValueKind != JsonValueKind.Array)
            return (now, result);

        foreach (var entry in aircraftEl.EnumerateArray())
        {
            var update = ParseEntry(entry);
            if (update is not null)
                result.Add(update);
        }

        return (now, result);
    }

    /// <summary>Convenience overload for string input (tests / fixtures).</summary>
    public static (double? Now, IReadOnlyList<AircraftUpdate> Aircraft) Parse(string json) =>
        Parse(System.Text.Encoding.UTF8.GetBytes(json));

    private static AircraftUpdate? ParseEntry(JsonElement entry)
    {
        if (entry.ValueKind != JsonValueKind.Object)
            return null;

        var hex = GetString(entry, "hex")?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(hex))
            return null;

        // dump1090 prefixes non-ICAO addresses with '~' (TIS-B/MLAT); keep them but normalize.
        var (altBaro, onGround) = ParseAltBaro(entry);

        return new AircraftUpdate
        {
            Hex = hex,
            Flight = GetString(entry, "flight")?.Trim() is { Length: > 0 } f ? f : null,
            Lat = GetDouble(entry, "lat"),
            Lon = GetDouble(entry, "lon"),
            AltBaro = altBaro,
            OnGround = onGround,
            GroundSpeed = GetDouble(entry, "gs"),
            Track = GetDouble(entry, "track"),
            BaroRate = GetInt(entry, "baro_rate"),
            Category = GetString(entry, "category"),
            Seen = GetDouble(entry, "seen"),
            SeenPos = GetDouble(entry, "seen_pos"),
        };
    }

    private static (int? AltBaro, bool OnGround) ParseAltBaro(JsonElement entry)
    {
        if (!entry.TryGetProperty("alt_baro", out var el))
            return (null, false);

        switch (el.ValueKind)
        {
            case JsonValueKind.Number:
                return (el.TryGetInt32(out var i) ? i : (int?)Math.Round(el.GetDouble()), false);
            case JsonValueKind.String:
                // The only documented string value is "ground".
                return string.Equals(el.GetString(), "ground", StringComparison.OrdinalIgnoreCase)
                    ? (null, true)
                    : (null, false);
            default:
                return (null, false);
        }
    }

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
}
