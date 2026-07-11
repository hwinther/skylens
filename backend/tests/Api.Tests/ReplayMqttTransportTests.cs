using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using Xunit;
using Skylens.Api.Ingest;
using Skylens.Api.Options;

namespace Skylens.Api.Tests;

/// <summary>
///     Covers the AIS fan-out added to <see cref="ReplayMqttTransport" />: the file-parsing seam
///     (<see cref="ReplayMqttTransport.ReadAisRecords" />) is asserted directly — it skips blank
///     separator lines and malformed records — and a connect-time smoke test proves the transport
///     publishes on BOTH the aircraft and AIS topics. The timer cadence itself isn't asserted (both
///     loops publish their first record immediately on connect, which is the testable seam); the loops
///     run on a <see cref="FakeTimeProvider" /> so nothing spins in real time.
/// </summary>
public sealed class ReplayMqttTransportTests
{
    private static string FixturePath(string name) =>
        Path.Combine(AppContext.BaseDirectory, "fixtures", name);

    private static string WriteTempJsonl(string contents)
    {
        var path = Path.Combine(Path.GetTempPath(), $"ais-{Guid.NewGuid():N}.jsonl");
        File.WriteAllText(path, contents);
        return path;
    }

    [Fact]
    public void ReadAisRecords_skips_blank_and_whitespace_lines_and_keeps_records_verbatim()
    {
        var path = WriteTempJsonl(
            "{\"type\":1,\"mmsi\":257000001}\n" +
            "\n" +                                 // blank separator line
            "   \n" +                              // whitespace-only line
            "{\"type\":21,\"mmsi\":992576411}\n");
        try
        {
            var records = ReplayMqttTransport.ReadAisRecords(path);

            Assert.Equal(2, records.Count);
            Assert.Equal("{\"type\":1,\"mmsi\":257000001}", Encoding.UTF8.GetString(records[0]));
            Assert.Equal("{\"type\":21,\"mmsi\":992576411}", Encoding.UTF8.GetString(records[1]));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void ReadAisRecords_skips_malformed_lines()
    {
        var path = WriteTempJsonl(
            "{\"type\":1,\"mmsi\":1}\n" +
            "not json\n" +
            "{ broken\n" +
            "{\"type\":3,\"mmsi\":2}\n");
        try
        {
            var records = ReplayMqttTransport.ReadAisRecords(path);

            Assert.Equal(2, records.Count); // only the two well-formed records survive
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void ReadAisRecords_reads_every_non_blank_record_from_the_real_capture()
    {
        var expected = File.ReadLines(FixturePath("ais-capture.jsonl"))
                           .Count(l => !string.IsNullOrWhiteSpace(l));

        var records = ReplayMqttTransport.ReadAisRecords(FixturePath("ais-capture.jsonl"));

        Assert.Equal(expected, records.Count);
        Assert.True(records.Count > 250, $"expected > 250 records but was {records.Count}");
    }

    [Fact]
    public async Task ConnectAsync_publishes_on_both_the_aircraft_and_ais_topics()
    {
        var options = Microsoft.Extensions.Options.Options.Create(new MqttOptions
        {
            Topic = "adsb/aircraft",
            ReplayFile = FixturePath("aircraft.json"),
            AisReplay = true,
            AisTopic = "ais/data",
            AisReplayFile = FixturePath("ais-capture.jsonl"),
        });

        await using var transport = new ReplayMqttTransport(
            options, new FakeTimeProvider(), NullLogger<ReplayMqttTransport>.Instance);

        var aircraft = new TaskCompletionSource<MqttMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        var ais = new TaskCompletionSource<MqttMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        transport.MessageReceived += message =>
        {
            if (string.Equals(message.Topic, "ais/data", StringComparison.Ordinal))
                ais.TrySetResult(message);
            else
                aircraft.TrySetResult(message);
            return Task.CompletedTask;
        };

        await transport.ConnectAsync(CancellationToken.None);

        // Both loops publish their first record immediately on connect (no timer advance needed). Await
        // the real events with a generous safety timeout rather than sleeping a fixed amount.
        var aircraftMessage = await aircraft.Task.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        var aisMessage = await ais.Task.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);

        // Aircraft replay is unchanged: the whole file is published byte-for-byte.
        Assert.Equal(await File.ReadAllBytesAsync(FixturePath("aircraft.json"), TestContext.Current.CancellationToken), aircraftMessage.Payload.ToArray());

        // AIS payload is a single, non-blank, well-formed record — not a blank separator line.
        var aisText = Encoding.UTF8.GetString(aisMessage.Payload.Span);
        Assert.False(string.IsNullOrWhiteSpace(aisText));
        using var doc = JsonDocument.Parse(aisText);
        Assert.Equal(JsonValueKind.Object, doc.RootElement.ValueKind);
    }

    [Fact]
    public void Constructor_throws_when_ais_replay_is_on_but_the_file_is_missing()
    {
        var options = Microsoft.Extensions.Options.Options.Create(new MqttOptions
        {
            Topic = "adsb/aircraft",
            ReplayFile = FixturePath("aircraft.json"),
            AisReplay = true,
            AisReplayFile = Path.Combine(Path.GetTempPath(), $"missing-{Guid.NewGuid():N}.jsonl"),
        });

        Assert.Throws<FileNotFoundException>(() =>
        {
            _ = new ReplayMqttTransport(options, new FakeTimeProvider(), NullLogger<ReplayMqttTransport>.Instance);
        });
    }
}
