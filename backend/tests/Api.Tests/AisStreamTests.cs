using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Skylens.Api.Broadcast;
using Skylens.Api.Enrichment;
using Skylens.Api.Options;
using Skylens.Api.State;
using Xunit;

namespace Skylens.Api.Tests;

/// <summary>
///     aisstream.io vessel away-mode: envelope parsing into the store (incl. AIS "not available"
///     sentinels), per-viewer answers + interest registration, the subscription message, interest expiry,
///     and the vessel chain falling through BarentsWatch's empty answer outside Norway.
/// </summary>
public sealed class AisStreamTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 7, 12, 0, 0, TimeSpan.Zero);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static AisStreamClient Client(FakeTimeProvider time, string? key = "key") =>
        new(Microsoft.Extensions.Options.Options.Create(new AisStreamOptions { ApiKey = key }),
            time,
            NullLogger<AisStreamClient>.Instance);

    private static byte[] Position(long mmsi, double lat, double lon, double sog = 12.3, double cog = 87.5, int hdg = 90,
                                   string type = "PositionReport", string name = "TEST SHIP           ") =>
        JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object>
        {
            ["MessageType"] = type,
            ["MetaData"] = new Dictionary<string, object>
            {
                ["MMSI"] = mmsi,
                ["ShipName"] = name,
                ["latitude"] = lat,
                ["longitude"] = lon,
                ["time_utc"] = "2026-11-07 12:00:00 +0000 UTC",
            },
            ["Message"] = new Dictionary<string, object>
            {
                [type] = new Dictionary<string, object>
                {
                    ["Cog"] = cog,
                    ["Sog"] = sog,
                    ["TrueHeading"] = hdg,
                    ["NavigationalStatus"] = 0,
                    ["UserID"] = mmsi,
                },
            },
        });

    [Fact]
    public async Task Position_reports_land_in_the_store_and_answer_viewers_within_radius()
    {
        var time = new FakeTimeProvider(T0);
        var client = Client(time);
        client.Apply(Position(244_000_001, 51.95, 4.10), T0); // Rotterdam approach
        client.Apply(Position(244_000_002, 53.50, 8.00), T0); // German Bight, ~300 km away

        var result = await client.GetAsync(51.9, 4.2, 50, Ct);

        Assert.Null(result.Reason);
        var v = Assert.Single(result.Vessels);
        Assert.Equal("244000001", v.Mmsi);
        Assert.Equal("TEST SHIP", v.Name);
        Assert.Equal("aisstream", v.Src);
        Assert.Equal(12.3, v.Sog);
        Assert.Equal(87.5, v.Cog);
        Assert.Equal(90, v.Hdg);
    }

    [Fact]
    public async Task Not_available_sentinels_become_null()
    {
        var time = new FakeTimeProvider(T0);
        var client = Client(time);
        client.Apply(Position(244_000_003, 51.95, 4.10, sog: 102.3, cog: 360, hdg: 511, type: "StandardClassBPositionReport"), T0);

        var v = Assert.Single((await client.GetAsync(51.95, 4.10, 10, Ct)).Vessels);
        Assert.Null(v.Sog);
        Assert.Null(v.Cog);
        Assert.Null(v.Hdg);
    }

    [Fact]
    public async Task Static_data_names_and_types_the_vessel()
    {
        var time = new FakeTimeProvider(T0);
        var client = Client(time);
        client.Apply(Position(244_000_004, 51.95, 4.10, name: ""), T0);
        client.Apply(Encoding.UTF8.GetBytes(
            """
            {"MessageType":"ShipStaticData","MetaData":{"MMSI":244000004},
             "Message":{"ShipStaticData":{"Name":"MAERSK TEST@@@@","Type":70,"Destination":"NLRTM"}}}
            """), T0);

        var v = Assert.Single((await client.GetAsync(51.95, 4.10, 10, Ct)).Vessels);
        Assert.Equal("MAERSK TEST", v.Name);
        Assert.Equal(70, v.ShipType);
    }

    [Fact]
    public void Malformed_frames_are_ignored()
    {
        var client = Client(new FakeTimeProvider(T0));
        client.Apply("not json"u8, T0);
        client.Apply("""{"MessageType":"PositionReport"}"""u8, T0);
        client.Apply("""{"MessageType":"PositionReport","MetaData":{"MMSI":1},"Message":{}}"""u8, T0);
        Assert.Equal(0, client.Count);
    }

    [Fact]
    public async Task Without_a_key_it_reports_unconfigured_and_registers_nothing()
    {
        var time = new FakeTimeProvider(T0);
        var client = Client(time, key: null);

        var result = await client.GetAsync(51.9, 4.2, 50, Ct);

        Assert.Equal("aisstream-unconfigured", result.Reason);
        Assert.Empty(client.ActiveCells(T0));
    }

    [Fact]
    public async Task Viewers_register_interest_in_the_cells_around_them_until_it_expires()
    {
        var time = new FakeTimeProvider(T0);
        var client = Client(time);

        await client.GetAsync(51.9, 4.2, 50, Ct);
        var cells = client.ActiveCells(T0);
        Assert.Contains((51, 4), cells);
        Assert.All(cells, c => Assert.InRange(c.Item1, 51, 52));

        Assert.Empty(client.ActiveCells(T0 + AisStreamClient.InterestTtl + TimeSpan.FromSeconds(1)));
    }

    [Fact]
    public void Cells_wrap_across_the_antimeridian()
    {
        var cells = AisStreamClient.CellsCovering(-17.5, 179.9, 30).ToList();
        Assert.Contains((-18, 179), cells);
        Assert.Contains((-18, -180), cells);
    }

    [Fact]
    public void Subscription_has_the_key_one_box_per_cell_and_the_message_filter()
    {
        var json = AisStreamClient.SubscriptionJson("secret", [(51, 4), (59, 10)]);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("secret", root.GetProperty("APIKey").GetString());
        var boxes = root.GetProperty("BoundingBoxes");
        Assert.Equal(2, boxes.GetArrayLength());
        Assert.Equal("[[51,4],[52,5]]", boxes[0].GetRawText());
        Assert.Contains("PositionReport", root.GetProperty("FilterMessageTypes").EnumerateArray().Select(e => e.GetString()));
    }

    [Fact]
    public async Task Stale_vessels_are_pruned()
    {
        var time = new FakeTimeProvider(T0);
        var client = Client(time);
        client.Apply(Position(244_000_005, 51.95, 4.10), T0);

        client.Prune(T0 + AisStreamClient.VesselTtl + TimeSpan.FromSeconds(1));

        Assert.Empty((await client.GetAsync(51.95, 4.10, 10, Ct)).Vessels);
    }

    // -- Vessel chain -------------------------------------------------------------------------------------

    private sealed class Fixed(VesselAwayResult result) : IVesselAwayModeSource
    {
        public int Calls { get; private set; }

        public Task<VesselAwayResult> GetAsync(double lat, double lon, double radiusKm, CancellationToken ct)
        {
            Calls++;
            return Task.FromResult(result);
        }
    }

    private static VesselAwayResult One(string src) =>
        new([new VesselDto { Mmsi = "1", Kind = "ship", Lat = 0, Lon = 0, Src = src }], null);

    [Fact]
    public async Task Chain_falls_through_an_empty_barentswatch_answer()
    {
        var bw = new Fixed(VesselAwayResult.Empty);
        var global = new Fixed(One("aisstream"));

        var result = await new VesselAwayChain([bw, global]).GetAsync(51.9, 4.2, 50, Ct);

        Assert.Equal("aisstream", Assert.Single(result.Vessels).Src);
    }

    [Fact]
    public async Task Chain_keeps_barentswatch_when_it_has_vessels()
    {
        var bw = new Fixed(One("barentswatch"));
        var global = new Fixed(One("aisstream"));

        var result = await new VesselAwayChain([bw, global]).GetAsync(60, 5, 50, Ct);

        Assert.Equal("barentswatch", Assert.Single(result.Vessels).Src);
        Assert.Equal(0, global.Calls);
    }

    [Fact]
    public async Task Chain_prefers_a_quiet_sea_over_a_reason_and_surfaces_the_first_reason_otherwise()
    {
        var quiet = await new VesselAwayChain(
            [new Fixed(new VesselAwayResult([], "away-mode-unconfigured")), new Fixed(VesselAwayResult.Empty)])
            .GetAsync(0, 0, 50, Ct);
        Assert.Null(quiet.Reason);

        var failing = await new VesselAwayChain(
            [new Fixed(new VesselAwayResult([], "barentswatch-unavailable")), new Fixed(new VesselAwayResult([], "aisstream-unconfigured"))])
            .GetAsync(0, 0, 50, Ct);
        Assert.Equal("barentswatch-unavailable", failing.Reason);
    }
}
