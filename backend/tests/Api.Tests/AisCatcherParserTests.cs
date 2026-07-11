using Xunit;
using Skylens.Api.Ingest;

namespace Skylens.Api.Tests;

/// <summary>
///     Deterministic parser-contract assertions against hand-built synthetic AIS messages — one per
///     message type plus the sentinel/edge cases. The real 348-message capture (ais-capture.jsonl) is
///     covered by <see cref="AisCatcherParserRealCaptureTests" /> with structural assertions only.
/// </summary>
public sealed class AisCatcherParserTests
{
    [Fact]
    public void Parse_type1_maps_class_a_position_fields()
    {
        const string json = """
            {"type":1,"mmsi":257681000,"lat":59.887573,"lon":10.747923,"speed":0,"course":237.7,"heading":241,"status":0,"status_text":"Under way using engine","country_code":"NO"}
            """;

        var v = AisCatcherParser.Parse(json);

        Assert.NotNull(v);
        Assert.Equal("257681000", v!.Mmsi);
        Assert.Equal(VesselKind.Ship, v.Kind);
        Assert.Equal(1, v.MsgType);
        Assert.Equal(59.887573, v.Lat);
        Assert.Equal(10.747923, v.Lon);
        Assert.True(v.HasPosition);
        Assert.Equal(0, v.Sog);
        Assert.Equal(237.7, v.Cog);
        Assert.Equal(241, v.Heading);
        Assert.Equal(0, v.NavStatus);
        Assert.Equal("Under way using engine", v.NavStatusText);
        Assert.Equal("NO", v.Flag);
    }

    [Fact]
    public void Parse_type2_is_treated_like_class_a_position()
    {
        const string json = """
            {"type":2,"mmsi":257000001,"lat":59.9,"lon":10.7,"speed":4.2,"course":180,"heading":179,"status":0,"country_code":"NO"}
            """;

        var v = AisCatcherParser.Parse(json);

        Assert.NotNull(v);
        Assert.Equal(2, v!.MsgType);
        Assert.Equal(VesselKind.Ship, v.Kind);
        Assert.True(v.HasPosition);
        Assert.Equal(4.2, v.Sog);
    }

    [Fact]
    public void Parse_type3_is_treated_like_class_a_position()
    {
        const string json = """
            {"type":3,"mmsi":258509000,"lat":59.904678,"lon":10.725806,"speed":9.9,"course":35.7,"heading":32,"status":0,"country_code":"NO"}
            """;

        var v = AisCatcherParser.Parse(json);

        Assert.NotNull(v);
        Assert.Equal(3, v!.MsgType);
        Assert.Equal(VesselKind.Ship, v.Kind);
        Assert.True(v.HasPosition);
    }

    [Fact]
    public void Parse_type5_maps_static_and_voyage_fields()
    {
        const string json = """
            {"type":5,"mmsi":257249000,"shipname":"DRONNINGEN","shiptype":60,"shiptype_text":"Passenger ships - all ships of this type","callsign":"LCDF","imo":9481192,"destination":"OSLO-NESODDTANGEN","eta":"01-01T12:00Z","draught":3.3,"to_bow":25,"to_stern":25,"to_port":6,"to_starboard":6,"country_code":"NO"}
            """;

        var v = AisCatcherParser.Parse(json);

        Assert.NotNull(v);
        Assert.Equal(5, v!.MsgType);
        Assert.Equal(VesselKind.Ship, v.Kind);
        Assert.False(v.HasPosition); // static/voyage reports carry no lat/lon
        Assert.Equal("DRONNINGEN", v.ShipName);
        Assert.Equal(60, v.ShipType);
        Assert.Equal("Passenger ships - all ships of this type", v.ShipTypeText);
        Assert.Equal("LCDF", v.CallSign);
        Assert.Equal(9481192L, v.Imo);
        Assert.Equal("OSLO-NESODDTANGEN", v.Destination);
        Assert.Equal(3.3, v.Draught);
        Assert.Equal(25, v.DimBow);
        Assert.Equal(25, v.DimStern);
        Assert.Equal(6, v.DimPort);
        Assert.Equal(6, v.DimStarboard);
    }

    [Fact]
    public void Parse_keeps_eta_as_a_raw_partial_string()
    {
        const string json = """
            {"type":5,"mmsi":257249000,"eta":"01-01T12:00Z","country_code":"NO"}
            """;

        var v = AisCatcherParser.Parse(json);

        // The partial "MM-DDTHH:mmZ" is carried verbatim — never parsed into a DateTime.
        Assert.Equal("01-01T12:00Z", v!.Eta);
    }

    [Fact]
    public void Parse_type18_maps_class_b_position_and_nulls_heading_sentinel()
    {
        const string json = """
            {"type":18,"mmsi":257711990,"speed":0,"lon":10.577408,"lat":59.875858,"course":41.6,"heading":511,"country_code":"NO"}
            """;

        var v = AisCatcherParser.Parse(json);

        Assert.NotNull(v);
        Assert.Equal(18, v!.MsgType);
        Assert.Equal(VesselKind.Ship, v.Kind);
        Assert.True(v.HasPosition);
        Assert.Equal(41.6, v.Cog);
        Assert.Null(v.Heading); // 511 = "not available"
    }

    [Fact]
    public void Parse_type19_maps_position_plus_shipname_and_shiptype()
    {
        // Type 19 (extended Class B) behaves like 18 but may also carry static fields.
        const string json = """
            {"type":19,"mmsi":257000019,"lat":59.9,"lon":10.7,"speed":5,"course":90,"heading":88,"shipname":"TESTBOAT","shiptype":37,"shiptype_text":"Pleasure craft","country_code":"NO"}
            """;

        var v = AisCatcherParser.Parse(json);

        Assert.NotNull(v);
        Assert.Equal(19, v!.MsgType);
        Assert.Equal(VesselKind.Ship, v.Kind);
        Assert.True(v.HasPosition);
        Assert.Equal("TESTBOAT", v.ShipName);
        Assert.Equal(37, v.ShipType);
    }

    [Fact]
    public void Parse_type21_maps_aton_fields_and_sets_aton_kind()
    {
        const string json = """
            {"type":21,"mmsi":992576411,"lat":59.122288,"lon":9.605837,"aid_type":5,"aid_type_text":"Light, without sectors","name":"VIRTUAL ATON(2)","virtual_aid":true,"off_position":false,"to_bow":0,"country_code":"NO"}
            """;

        var v = AisCatcherParser.Parse(json);

        Assert.NotNull(v);
        Assert.Equal(21, v!.MsgType);
        Assert.Equal(VesselKind.Aton, v.Kind);
        Assert.Equal(5, v.AidType);
        Assert.Equal("Light, without sectors", v.AidTypeText);
        Assert.Equal("VIRTUAL ATON(2)", v.AtonName);
        Assert.True(v.VirtualAid);
        Assert.False(v.OffPosition);
        Assert.True(v.HasPosition);
        Assert.Null(v.ShipName); // AtoN carries `name`, not `shipname`
    }

    [Fact]
    public void Parse_type24_part_a_carries_shipname()
    {
        // AIS-catcher reports Part A as partno 0 (some encoders/docs use 1); we never gate on partno.
        const string json = """
            {"type":24,"mmsi":258014210,"partno":0,"shipname":"LUMIA","country_code":"NO"}
            """;

        var v = AisCatcherParser.Parse(json);

        Assert.NotNull(v);
        Assert.Equal(24, v!.MsgType);
        Assert.Equal("LUMIA", v.ShipName);
        Assert.Null(v.ShipType);
        Assert.Null(v.CallSign);
        Assert.False(v.HasPosition);
    }

    [Fact]
    public void Parse_type24_part_b_carries_type_callsign_and_dimensions()
    {
        const string json = """
            {"type":24,"mmsi":258523710,"partno":1,"shiptype":36,"shiptype_text":"Sailing","callsign":"LE9237","to_bow":6,"to_stern":6,"to_port":1,"to_starboard":3,"vendorid":"SRT","country_code":"NO"}
            """;

        var v = AisCatcherParser.Parse(json);

        Assert.NotNull(v);
        Assert.Equal(36, v!.ShipType);
        Assert.Equal("Sailing", v.ShipTypeText);
        Assert.Equal("LE9237", v.CallSign);
        Assert.Equal(6, v.DimBow);
        Assert.Equal(3, v.DimStarboard);
        Assert.Null(v.ShipName); // Part B carries no name; the store merges it from Part A
    }

    [Fact]
    public void Parse_maps_class_a_sentinels_to_null()
    {
        // speed 102.3, course 360, heading 511 are the AIS "not available" sentinels; turn -128 is one
        // too but isn't a field we carry, so it must simply be ignored without disturbing parsing.
        const string json = """
            {"type":1,"mmsi":257000002,"lat":59.9,"lon":10.7,"speed":102.3,"course":360,"heading":511,"turn":-128,"status":15,"country_code":"NO"}
            """;

        var v = AisCatcherParser.Parse(json);

        Assert.NotNull(v);
        Assert.Null(v!.Sog);
        Assert.Null(v.Cog);
        Assert.Null(v.Heading);
        Assert.True(v.HasPosition); // the position itself is valid
        Assert.Equal(15, v.NavStatus);
    }

    [Fact]
    public void Parse_maps_out_of_range_lat_lon_to_no_position()
    {
        const string json = """
            {"type":1,"mmsi":257000003,"lat":91,"lon":181,"speed":5,"course":90,"heading":90,"country_code":"NO"}
            """;

        var v = AisCatcherParser.Parse(json);

        Assert.NotNull(v);
        Assert.False(v!.HasPosition);
        Assert.Null(v.Lat);
        Assert.Null(v.Lon);
        Assert.Equal(5, v.Sog); // non-position fields still decode
    }

    [Fact]
    public void Parse_reads_numbers_as_int_or_float()
    {
        // mmsi as a float, heading/shiptype as floats — all must decode via the tolerant readers.
        const string json = """
            {"type":1,"mmsi":257000004.0,"lat":59.9,"lon":10.7,"heading":241.0,"course":90.5,"speed":9.9,"country_code":"NO"}
            """;

        var v = AisCatcherParser.Parse(json);

        Assert.NotNull(v);
        Assert.Equal("257000004", v!.Mmsi);
        Assert.Equal(241, v.Heading);
        Assert.Equal(90.5, v.Cog);
    }

    [Fact]
    public void Parse_returns_null_for_type4_base_station()
    {
        const string json = """
            {"type":4,"mmsi":2573104,"lat":59.888966,"lon":10.753845,"country_code":"NO"}
            """;

        Assert.Null(AisCatcherParser.Parse(json));
    }

    [Fact]
    public void Parse_returns_null_for_untracked_type()
    {
        Assert.Null(AisCatcherParser.Parse("""{"type":9,"mmsi":257000005}"""));
    }

    [Fact]
    public void Parse_returns_null_for_missing_mmsi()
    {
        Assert.Null(AisCatcherParser.Parse("""{"type":1,"lat":59.9,"lon":10.7}"""));
    }

    [Fact]
    public void Parse_returns_null_for_missing_type()
    {
        Assert.Null(AisCatcherParser.Parse("""{"mmsi":257000006,"lat":59.9}"""));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not json")]
    [InlineData("{ broken")]
    [InlineData("[]")]
    [InlineData("42")]
    public void Parse_returns_null_for_blank_or_malformed_input(string input)
    {
        // A bad line must never throw — one malformed message can't be allowed to break the ingest loop.
        Assert.Null(AisCatcherParser.Parse(input));
    }
}
