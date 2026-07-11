using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Skylens.Api.Options;

namespace Skylens.Api.Ingest;

/// <summary>
///     Dev/E2E <see cref="IMqttTransport" /> that replays a dump1090 <c>aircraft.json</c> file instead
///     of connecting to a broker. On <see cref="ConnectAsync" /> it starts a 1 Hz loop that raises
///     <see cref="MessageReceived" /> with the file's bytes, so the parser → state store → broadcaster
///     path runs exactly as it would for live MQTT data. Registered only when <c>Mqtt:Replay=true</c>
///     in Development (see Program.cs) — never in production.
///     <para>
///         When <c>Mqtt:AisReplay=true</c> a second loop fans a captured AIS-catcher JSONL file
///         (<c>Mqtt:AisReplayFile</c>) onto <see cref="MqttOptions.AisTopic" /> at ~5 records/second,
///         cycling forever, so the vessel pipeline runs against canned data too. The aircraft loop is
///         untouched by this — with AisReplay off the transport behaves exactly as before.
///     </para>
/// </summary>
public sealed class ReplayMqttTransport : IMqttTransport
{
    // AIS records fan out faster than the 1 Hz aircraft snapshot: a real capture carries many small
    // per-vessel messages, so ~5/second keeps the replayed vessel set moving without a real broker.
    private static readonly TimeSpan AisInterval = TimeSpan.FromMilliseconds(200);

    private readonly byte[] _payload;
    private readonly string _topic;
    private readonly TimeProvider _time;
    private readonly ILogger<ReplayMqttTransport> _logger;

    private readonly bool _aisEnabled;
    private readonly string _aisTopic;
    private readonly IReadOnlyList<byte[]> _aisRecords = [];

    private CancellationTokenSource? _cts;
    private Task? _loop;
    private Task? _aisLoop;

    public ReplayMqttTransport(
        IOptions<MqttOptions> options,
        TimeProvider time,
        ILogger<ReplayMqttTransport> logger)
    {
        _time = time;
        _logger = logger;
        _topic = options.Value.Topic;

        var path = options.Value.ReplayFile;
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            throw new FileNotFoundException(
                $"Mqtt:Replay is on but Mqtt:ReplayFile '{path}' was not found.", path);

        _payload = File.ReadAllBytes(path);

        // Optional AIS fan-out: mirror the aircraft file check so a bad config fails fast in dev/e2e.
        _aisTopic = options.Value.AisTopic;
        if (options.Value.AisReplay)
        {
            var aisPath = options.Value.AisReplayFile;
            if (string.IsNullOrWhiteSpace(aisPath) || !File.Exists(aisPath))
                throw new FileNotFoundException(
                    $"Mqtt:AisReplay is on but Mqtt:AisReplayFile '{aisPath}' was not found.", aisPath);

            _aisRecords = ReadAisRecords(aisPath);
            // Nothing to replay if every line was blank/malformed — leave the AIS loop unstarted.
            _aisEnabled = _aisRecords.Count > 0 && !string.IsNullOrEmpty(_aisTopic);
        }
    }

    public event Func<MqttMessage, Task>? MessageReceived;

    public bool IsConnected { get; private set; }

    public Task ConnectAsync(CancellationToken ct)
    {
        IsConnected = true;
        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _loop = Task.Run(() => ReplayLoopAsync(_cts.Token), CancellationToken.None);
        _logger.LogInformation("Replay transport connected; publishing {Bytes} bytes at 1 Hz", _payload.Length);

        if (_aisEnabled)
        {
            _aisLoop = Task.Run(() => AisReplayLoopAsync(_cts.Token), CancellationToken.None);
            _logger.LogInformation("AIS replay enabled; cycling {Records} records on {Topic} at ~5 Hz",
                _aisRecords.Count, _aisTopic);
        }

        return Task.CompletedTask;
    }

    public Task SubscribeAsync(string topic, int qos, CancellationToken ct) => Task.CompletedTask;

    /// <summary>
    ///     Reads a captured AIS-catcher JSONL file into one UTF-8 payload per record. Tolerant by design:
    ///     blank separator lines and any line that doesn't parse as JSON are skipped, so a re-captured or
    ///     hand-edited fixture can never break replay. Exposed for unit testing the parse seam.
    /// </summary>
    public static List<byte[]> ReadAisRecords(string path)
    {
        var records = new List<byte[]>();
        foreach (var raw in File.ReadLines(path))
        {
            var line = raw.Trim();
            if (line.Length == 0)
                continue; // blank separator line between records

            try
            {
                using var _ = JsonDocument.Parse(line);
            }
            catch (JsonException)
            {
                continue; // malformed record — skip, never let it break the replay loop
            }

            records.Add(Encoding.UTF8.GetBytes(line));
        }

        return records;
    }

    private async Task ReplayLoopAsync(CancellationToken ct)
    {
        var message = new MqttMessage(_topic, _payload);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1), _time);
        try
        {
            // Publish once immediately so viewers see data on their first snapshot tick.
            await Publish(message);
            while (await timer.WaitForNextTickAsync(ct))
                await Publish(message);
        }
        catch (OperationCanceledException)
        {
            // stopping
        }
    }

    private async Task AisReplayLoopAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(AisInterval, _time);
        var index = 0;
        try
        {
            // Publish the first record immediately (mirrors the aircraft loop) then step one record per
            // tick, cycling the capture forever like the aircraft file re-publishes forever.
            await Publish(new MqttMessage(_aisTopic, _aisRecords[index]));
            index = (index + 1) % _aisRecords.Count;
            while (await timer.WaitForNextTickAsync(ct))
            {
                await Publish(new MqttMessage(_aisTopic, _aisRecords[index]));
                index = (index + 1) % _aisRecords.Count;
            }
        }
        catch (OperationCanceledException)
        {
            // stopping
        }
    }

    private Task Publish(MqttMessage message) => MessageReceived?.Invoke(message) ?? Task.CompletedTask;

    public async ValueTask DisposeAsync()
    {
        IsConnected = false;
        if (_cts is not null)
            await _cts.CancelAsync();

        foreach (var task in new[] { _loop, _aisLoop })
        {
            if (task is null)
                continue;
            try
            {
                await task;
            }
            catch (OperationCanceledException)
            {
                // expected on shutdown
            }
        }

        _cts?.Dispose();
    }
}
