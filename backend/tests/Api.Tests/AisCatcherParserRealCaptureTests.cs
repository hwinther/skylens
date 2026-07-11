using Xunit;
using Skylens.Api.Ingest;
using Skylens.Api.State;

namespace Skylens.Api.Tests;

/// <summary>
///     Structural tests against <c>fixtures/ais-capture.jsonl</c> — a REAL 348-message AIS-catcher capture
///     (one JSON object per line, blank lines between records). These assert only invariants that hold for
///     ANY valid capture; nothing depends on a specific vessel, so the fixture can be re-captured freely.
///     Exact-value parser-contract assertions live in <see cref="AisCatcherParserTests" />.
/// </summary>
public sealed class AisCatcherParserRealCaptureTests
{
    private static IEnumerable<string> CaptureLines() =>
        File.ReadLines(Path.Combine(AppContext.BaseDirectory, "fixtures", "ais-capture.jsonl"))
            .Where(l => !string.IsNullOrWhiteSpace(l)); // skip the blank lines between records

    private static IReadOnlyList<VesselUpdate> ParsedTargets() =>
        CaptureLines()
            .Select(AisCatcherParser.Parse)
            .Where(v => v is not null)
            .Select(v => v!)
            .ToList();

    [Fact]
    public void Every_non_empty_line_parses_without_throwing()
    {
        var ex = Record.Exception(() =>
        {
            foreach (var line in CaptureLines())
                _ = AisCatcherParser.Parse(line);
        });

        Assert.Null(ex);
    }

    [Fact]
    public void Parses_more_than_250_targets()
    {
        var count = ParsedTargets().Count;

        Assert.True(count > 250, $"expected > 250 parsed targets but was {count}");
    }

    [Fact]
    public void Every_parsed_target_has_a_non_empty_mmsi()
    {
        Assert.All(ParsedTargets(), v => Assert.False(string.IsNullOrEmpty(v.Mmsi)));
    }

    [Fact]
    public void Every_type21_line_decodes_to_an_aton()
    {
        foreach (var line in CaptureLines())
        {
            var v = AisCatcherParser.Parse(line);
            if (v is { MsgType: 21 })
                Assert.Equal(VesselKind.Aton, v.Kind);
        }

        // Guard against the loop above being vacuous — the capture really does contain AtoNs.
        Assert.Contains(ParsedTargets(), v => v.Kind == VesselKind.Aton);
    }

    [Fact]
    public void At_least_one_ship_has_a_name_and_one_has_a_position()
    {
        var parsed = ParsedTargets();

        Assert.Contains(parsed, v => v.Kind == VesselKind.Ship && !string.IsNullOrEmpty(v.ShipName));
        Assert.Contains(parsed, v => v.Kind == VesselKind.Ship && v.HasPosition);
    }

    [Fact]
    public void No_target_throws_on_dto_conversion()
    {
        var now = DateTimeOffset.UtcNow;

        var ex = Record.Exception(() =>
        {
            foreach (var v in ParsedTargets())
            {
                var state = VesselState.FromUpdate(v, now);
                _ = VesselDto.FromState(state, now);
            }
        });

        Assert.Null(ex);
    }
}
