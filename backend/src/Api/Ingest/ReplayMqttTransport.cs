using Microsoft.Extensions.Options;
using Skylens.Api.Options;

namespace Skylens.Api.Ingest;

/// <summary>
///     Dev/E2E <see cref="IMqttTransport" /> that replays a dump1090 <c>aircraft.json</c> file instead
///     of connecting to a broker. On <see cref="ConnectAsync" /> it starts a 1 Hz loop that raises
///     <see cref="MessageReceived" /> with the file's bytes, so the parser → state store → broadcaster
///     path runs exactly as it would for live MQTT data. Registered only when <c>Mqtt:Replay=true</c>
///     in Development (see Program.cs) — never in production.
/// </summary>
public sealed class ReplayMqttTransport : IMqttTransport
{
    private readonly byte[] _payload;
    private readonly string _topic;
    private readonly TimeProvider _time;
    private readonly ILogger<ReplayMqttTransport> _logger;

    private CancellationTokenSource? _cts;
    private Task? _loop;

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
    }

    public event Func<MqttMessage, Task>? MessageReceived;

    public bool IsConnected { get; private set; }

    public Task ConnectAsync(CancellationToken ct)
    {
        IsConnected = true;
        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _loop = Task.Run(() => ReplayLoopAsync(_cts.Token), CancellationToken.None);
        _logger.LogInformation("Replay transport connected; publishing {Bytes} bytes at 1 Hz", _payload.Length);
        return Task.CompletedTask;
    }

    public Task SubscribeAsync(string topic, int qos, CancellationToken ct) => Task.CompletedTask;

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

    private Task Publish(MqttMessage message) => MessageReceived?.Invoke(message) ?? Task.CompletedTask;

    public async ValueTask DisposeAsync()
    {
        IsConnected = false;
        if (_cts is not null)
            await _cts.CancelAsync();
        if (_loop is not null)
        {
            try
            {
                await _loop;
            }
            catch (OperationCanceledException)
            {
                // expected on shutdown
            }
        }

        _cts?.Dispose();
    }
}
