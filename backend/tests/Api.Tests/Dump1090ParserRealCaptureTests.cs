using Xunit;
using Skylens.Api.Ingest;
using Skylens.Api.State;

namespace Skylens.Api.Tests;

/// <summary>
///     Structural tests against <c>fixtures/aircraft.json</c> — a REAL dump1090-fa capture from the live
///     feed (refreshed via the mosquitto_sub command in fixtures/README.md). These assert only invariants
///     that hold for ANY valid capture; nothing depends on specific aircraft, so the fixture can be
///     re-captured freely. Exact-value parser-contract assertions live in <see cref="Dump1090ParserTests" />
///     against the synthetic fixture.
/// </summary>
public sealed class Dump1090ParserRealCaptureTests
{
    private static string CaptureJson() =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "aircraft.json"));

    private static (double? Now, IReadOnlyList<AircraftUpdate> Aircraft) ParseCapture() =>
        Dump1090Parser.Parse(CaptureJson());

    [Fact]
    public void Parses_without_throwing()
    {
        var ex = Record.Exception(() => ParseCapture());
        Assert.Null(ex);
    }

    [Fact]
    public void Now_is_present_and_positive()
    {
        var (now, _) = ParseCapture();

        Assert.NotNull(now);
        Assert.True(now > 0, $"expected now > 0 but was {now}");
    }

    [Fact]
    public void Parses_at_least_one_aircraft()
    {
        var (_, aircraft) = ParseCapture();

        Assert.NotEmpty(aircraft);
    }

    [Fact]
    public void Every_update_has_a_non_empty_lowercase_hex()
    {
        var (_, aircraft) = ParseCapture();

        Assert.All(aircraft, a =>
        {
            Assert.False(string.IsNullOrEmpty(a.Hex), "hex must be non-empty");
            Assert.Equal(a.Hex.ToLowerInvariant(), a.Hex);
        });
    }

    [Fact]
    public void Positioned_subset_is_no_larger_than_the_total()
    {
        var (_, aircraft) = ParseCapture();

        var positioned = aircraft.Count(a => a.HasPosition);

        Assert.InRange(positioned, 0, aircraft.Count);
    }

    [Fact]
    public void Positioned_updates_have_both_lat_and_lon()
    {
        var (_, aircraft) = ParseCapture();

        Assert.All(aircraft.Where(a => a.HasPosition), a =>
        {
            Assert.NotNull(a.Lat);
            Assert.NotNull(a.Lon);
        });
    }

    [Fact]
    public void No_update_throws_on_dto_conversion()
    {
        var (_, aircraft) = ParseCapture();
        var now = DateTimeOffset.UtcNow;

        var ex = Record.Exception(() =>
        {
            foreach (var update in aircraft)
            {
                var state = AircraftState.FromUpdate(update, now);
                _ = AircraftDto.FromState(state);
            }
        });

        Assert.Null(ex);
    }

    [Fact]
    public void Numeric_altitudes_are_within_a_sane_range()
    {
        var (_, aircraft) = ParseCapture();

        // dump1090 emits "ground" as a string (parsed to OnGround + null AltBaro); every numeric
        // barometric altitude that survives parsing should sit in a physically plausible band.
        Assert.All(aircraft.Where(a => a.AltBaro.HasValue), a =>
            Assert.InRange(a.AltBaro!.Value, -2000, 60000));
    }
}
