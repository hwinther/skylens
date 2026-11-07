using System.Collections.Concurrent;
using System.Globalization;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Skylens.Api.Broadcast;
using Skylens.Api.Ingest;
using Skylens.Api.Options;
using Skylens.Api.State;

namespace Skylens.Api.Enrichment;

/// <summary>
///     aisstream.io vessel away-mode source, tagged <c>src:"aisstream"</c>: free, global terrestrial AIS
///     over a WebSocket (needs a free API key — <c>AisStream:ApiKey</c> — and is in beta upstream). Unlike
///     the point-query sources it is a stream, so this is a hosted service that keeps ONE connection and an
///     in-memory store:
///     <list type="bullet">
///         <item>
///             <see cref="GetAsync" /> registers interest in the 1° cells covering the viewer's radius and
///             answers from the store (nearest <see cref="VesselBroadcaster.MaxVessels" />). No upstream call
///             per viewer, so there is no fan-out to budget.
///         </item>
///         <item>
///             The loop subscribes to exactly the cells someone asked about in the last
///             <see cref="InterestTtl" /> (a resubscribe swaps the boxes on the same socket), disconnects when
///             nobody is looking, and prunes vessels not heard from in <see cref="VesselTtl" />.
///         </item>
///     </list>
///     The first answer for a new area is empty until messages arrive (seconds for busy waters).
/// </summary>
public sealed class AisStreamClient : BackgroundService, IVesselAwayModeSource
{
    internal const double CellSizeDeg = 1.0;

    /// <summary>A cell stays subscribed this long after the last viewer asked for it.</summary>
    internal static readonly TimeSpan InterestTtl = TimeSpan.FromMinutes(2);

    /// <summary>Vessels not heard from for this long are dropped.</summary>
    internal static readonly TimeSpan VesselTtl = TimeSpan.FromMinutes(15);

    /// <summary>Upper bound on subscribed boxes, so a burst of far-apart viewers can't subscribe the world.</summary>
    internal const int MaxCells = 64;

    private static readonly TimeSpan LoopInterval = TimeSpan.FromSeconds(5);

    internal static readonly string[] MessageTypes =
    [
        "PositionReport",
        "StandardClassBPositionReport",
        "ExtendedClassBPositionReport",
        "ShipStaticData",
        "StaticDataReport",
    ];

    private readonly AisStreamOptions _options;
    private readonly TimeProvider _time;
    private readonly ILogger<AisStreamClient> _logger;
    private readonly ConcurrentDictionary<(int, int), DateTimeOffset> _interest = new();
    private readonly ConcurrentDictionary<string, VesselState> _vessels = new();

    public AisStreamClient(IOptions<AisStreamOptions> options, TimeProvider time, ILogger<AisStreamClient> logger)
    {
        _options = options.Value;
        _time = time;
        _logger = logger;
    }

    public bool Configured => _options.Enabled && !string.IsNullOrEmpty(_options.ApiKey);

    /// <summary>Vessels currently held (for tests / diagnostics).</summary>
    internal int Count => _vessels.Count;

    public Task<VesselAwayResult> GetAsync(double lat, double lon, double radiusKm, CancellationToken ct)
    {
        if (!Configured)
            return Task.FromResult(new VesselAwayResult([], "aisstream-unconfigured"));

        var now = _time.GetUtcNow();
        foreach (var cell in CellsCovering(lat, lon, radiusKm))
            _interest[cell] = now;

        var nearest = _vessels.Values
                              .Where(v => v.Lat is not null && v.Lon is not null)
                              .Select(v => (v, d: Geo.DistanceKm(lat, lon, v.Lat!.Value, v.Lon!.Value)))
                              .Where(x => x.d <= radiusKm)
                              .OrderBy(x => x.d)
                              .Take(VesselBroadcaster.MaxVessels)
                              .Select(x => VesselDto.FromState(x.v, now, "aisstream"))
                              .ToList();
        return Task.FromResult(new VesselAwayResult(nearest, null));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!Configured)
            return;

        var backoff = TimeSpan.FromSeconds(5);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var cells = ActiveCells(_time.GetUtcNow());
                if (cells.Count == 0)
                {
                    Prune(_time.GetUtcNow());
                    await Task.Delay(LoopInterval, _time, stoppingToken);
                    continue;
                }

                await RunConnectionAsync(stoppingToken);
                backoff = TimeSpan.FromSeconds(5);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "aisstream connection failed; retrying in {Backoff}", backoff);
                await Task.Delay(backoff, _time, stoppingToken);
                backoff = TimeSpan.FromSeconds(Math.Min(120, backoff.TotalSeconds * 2));
            }
        }
    }

    /// <summary>One connection: subscribe, read until nobody is interested any more (or it drops).</summary>
    private async Task RunConnectionAsync(CancellationToken stoppingToken)
    {
        using var ws = new ClientWebSocket();
        await ws.ConnectAsync(new Uri(_options.Url), stoppingToken);
        var subscribed = ActiveCells(_time.GetUtcNow());
        // Must arrive within 3 s of opening the socket or aisstream closes it.
        await SendAsync(ws, SubscriptionJson(_options.ApiKey!, subscribed), stoppingToken);
        _logger.LogInformation("aisstream subscribed to {Cells} cell(s)", subscribed.Count);

        using var connCts = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        var receive = ReceiveLoopAsync(ws, connCts.Token);
        try
        {
            while (!receive.IsCompleted)
            {
                var finished = await Task.WhenAny(receive, Task.Delay(LoopInterval, _time, stoppingToken));
                if (finished == receive)
                    break;

                var now = _time.GetUtcNow();
                Prune(now);
                var cells = ActiveCells(now);
                if (cells.Count == 0)
                {
                    _logger.LogInformation("aisstream idle; disconnecting");
                    await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "idle", stoppingToken);
                    break;
                }

                if (!cells.SetEquals(subscribed))
                {
                    subscribed = cells;
                    await SendAsync(ws, SubscriptionJson(_options.ApiKey!, subscribed), stoppingToken);
                    _logger.LogInformation("aisstream resubscribed to {Cells} cell(s)", subscribed.Count);
                }
            }
        }
        finally
        {
            await connCts.CancelAsync();
            try
            {
                await receive;
            }
            catch (Exception ex) when (ex is OperationCanceledException or WebSocketException)
            {
                // Expected when the connection is torn down.
            }
        }

        // A receive loop that ended on its own (server close / error) surfaces as a reconnect.
        if (receive.IsFaulted)
            await receive;
    }

    private async Task ReceiveLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[16 * 1024];
        using var message = new MemoryStream();
        while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
        {
            message.SetLength(0);
            WebSocketReceiveResult result;
            do
            {
                result = await ws.ReceiveAsync(buffer, ct);
                if (result.MessageType == WebSocketMessageType.Close)
                    return;
                message.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);

            Apply(message.GetBuffer().AsSpan(0, (int)message.Length), _time.GetUtcNow());
        }
    }

    private static Task SendAsync(ClientWebSocket ws, string json, CancellationToken ct) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, ct);

    /// <summary>Cells someone asked about within <see cref="InterestTtl" />; forgets the rest.</summary>
    internal HashSet<(int, int)> ActiveCells(DateTimeOffset now)
    {
        foreach (var (cell, at) in _interest)
            if (now - at > InterestTtl)
                _interest.TryRemove(cell, out _);
        return _interest.OrderByDescending(kv => kv.Value).Take(MaxCells).Select(kv => kv.Key).ToHashSet();
    }

    internal void Prune(DateTimeOffset now)
    {
        foreach (var (mmsi, v) in _vessels)
            if (now - v.LastSeenUtc > VesselTtl)
                _vessels.TryRemove(mmsi, out _);
    }

    /// <summary>The 1° cells overlapping the viewer's radius (a lat/lon box around it).</summary>
    internal static IEnumerable<(int, int)> CellsCovering(double lat, double lon, double radiusKm)
    {
        var dLat = radiusKm / 111.0;
        var dLon = radiusKm / (111.0 * Math.Max(0.1, Math.Cos(lat * Math.PI / 180)));
        var r0 = (int)Math.Floor(Math.Max(-90, lat - dLat) / CellSizeDeg);
        var r1 = (int)Math.Floor(Math.Min(89.999, lat + dLat) / CellSizeDeg);
        var c0 = (int)Math.Floor((lon - dLon) / CellSizeDeg);
        var c1 = (int)Math.Floor((lon + dLon) / CellSizeDeg);
        for (var r = r0; r <= r1; r++)
        for (var c = c0; c <= c1; c++)
            yield return (r, WrapCol(c));
    }

    private static int WrapCol(int c)
    {
        var cols = (int)(360 / CellSizeDeg);
        var min = (int)(-180 / CellSizeDeg);
        return ((c - min) % cols + cols) % cols + min;
    }

    /// <summary>The subscription message: one [[south, west], [north, east]] box per cell.</summary>
    internal static string SubscriptionJson(string apiKey, IEnumerable<(int Row, int Col)> cells)
    {
        var boxes = cells.OrderBy(c => c).Select(c => new[]
        {
            new[] { c.Row * CellSizeDeg, c.Col * CellSizeDeg },
            new[] { (c.Row + 1) * CellSizeDeg, (c.Col + 1) * CellSizeDeg },
        }).ToArray();
        return JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["APIKey"] = apiKey,
            ["BoundingBoxes"] = boxes,
            ["FilterMessageTypes"] = MessageTypes,
        });
    }

    /// <summary>
    ///     Applies one aisstream envelope (<c>{MessageType, MetaData{MMSI, ShipName, latitude, longitude},
    ///     Message{&lt;type&gt;{...}}}</c>) to the store. Malformed or unknown messages are ignored.
    /// </summary>
    internal void Apply(ReadOnlySpan<byte> json, DateTimeOffset now)
    {
        try
        {
            var reader = new Utf8JsonReader(json);
            using var doc = JsonDocument.ParseValue(ref reader);
            var root = doc.RootElement;
            if (!root.TryGetProperty("MessageType", out var typeEl) || typeEl.GetString() is not { } type)
                return;
            if (!root.TryGetProperty("MetaData", out var meta) ||
                !meta.TryGetProperty("MMSI", out var mmsiEl) || !mmsiEl.TryGetInt64(out var mmsiNum))
                return;
            var mmsi = mmsiNum.ToString(CultureInfo.InvariantCulture);
            if (!root.TryGetProperty("Message", out var msgRoot) || !msgRoot.TryGetProperty(type, out var msg))
                return;

            var v = _vessels.GetOrAdd(mmsi, static m => new VesselState { Mmsi = m, Kind = VesselKind.Ship });
            lock (v)
            {
                v.LastSeenUtc = now;
                if (Text(meta, "ShipName") is { } metaName)
                    v.ShipName ??= metaName;

                switch (type)
                {
                    case "PositionReport":
                    case "StandardClassBPositionReport":
                    case "ExtendedClassBPositionReport":
                        if (Number(meta, "latitude") is { } lat && Number(meta, "longitude") is { } lon &&
                            Math.Abs(lat) <= 90 && Math.Abs(lon) <= 180)
                        {
                            v.Lat = lat;
                            v.Lon = lon;
                        }

                        // AIS "not available" sentinels: SOG 102.3, COG 360, heading 511.
                        v.Sog = Number(msg, "Sog") is { } sog && sog < 102.3 ? sog : null;
                        v.Cog = Number(msg, "Cog") is { } cog && cog < 360 ? cog : null;
                        v.Heading = Number(msg, "TrueHeading") is { } hdg && hdg < 360 ? hdg : null;
                        if (Number(msg, "NavigationalStatus") is { } nav)
                            v.NavStatus = (int)nav;
                        if (type == "ExtendedClassBPositionReport" && Number(msg, "Type") is { } extType && extType > 0)
                            v.ShipType = (int)extType;
                        break;

                    case "ShipStaticData":
                        if (Text(msg, "Name") is { } name)
                            v.ShipName = name;
                        if (Number(msg, "Type") is { } shipType && shipType > 0)
                            v.ShipType = (int)shipType;
                        break;

                    case "StaticDataReport":
                        if (msg.TryGetProperty("ReportA", out var a) && Text(a, "Name") is { } nameA)
                            v.ShipName = nameA;
                        if (msg.TryGetProperty("ReportB", out var b) && Number(b, "ShipType") is { } typeB && typeB > 0)
                            v.ShipType = (int)typeB;
                        break;
                }
            }
        }
        catch (JsonException)
        {
            // Malformed frame — skip; never let one bad message kill the stream.
        }
    }

    private static double? Number(JsonElement el, string name) =>
        el.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Number ? p.GetDouble() : null;

    /// <summary>Trimmed string, null when empty (AIS pads names with spaces / '@').</summary>
    private static string? Text(JsonElement el, string name)
    {
        if (!el.TryGetProperty(name, out var p) || p.ValueKind != JsonValueKind.String)
            return null;
        var s = p.GetString()?.Trim().TrimEnd('@').Trim();
        return string.IsNullOrEmpty(s) ? null : s;
    }
}
