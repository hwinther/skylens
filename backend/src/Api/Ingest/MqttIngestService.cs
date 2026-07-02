using Microsoft.Extensions.Options;
using Skylens.Api.Options;
using Skylens.Api.State;

namespace Skylens.Api.Ingest;

/// <summary>
///     Hand-rolled MQTT ingest: connect → subscribe <c>adsb/aircraft</c> QoS 0 → consume → on drop,
///     reconnect with exponential backoff (1s → 30s) + jitter. MQTTnet v5 has no ManagedClient, so the
///     loop lives here and is unit-testable via <see cref="IMqttTransport" />.
/// </summary>
public sealed class MqttIngestService : BackgroundService
{
    private static readonly TimeSpan MinBackoff = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromSeconds(30);

    private readonly IMqttTransport _transport;
    private readonly MqttOptions _options;
    private readonly AircraftStateStore _store;
    private readonly IngestStatus _status;
    private readonly TimeProvider _time;
    private readonly ILogger<MqttIngestService> _logger;

    public MqttIngestService(
        IMqttTransport transport,
        IOptions<MqttOptions> options,
        AircraftStateStore store,
        IngestStatus status,
        TimeProvider time,
        ILogger<MqttIngestService> logger)
    {
        _transport = transport;
        _options = options.Value;
        _store = store;
        _status = status;
        _time = time;
        _logger = logger;
        _transport.MessageReceived += OnMessageAsync;
    }

    /// <summary>Exponential backoff with full jitter, clamped to [1s, 30s].</summary>
    public static TimeSpan ComputeBackoff(int attempt, Func<double> nextDouble)
    {
        // attempt 0 -> ~1s window, doubling each failure, capped at 30s.
        var exp = MinBackoff.TotalSeconds * Math.Pow(2, Math.Max(0, attempt));
        var capped = Math.Min(exp, MaxBackoff.TotalSeconds);
        // full jitter: uniformly random in [0, capped], floored at MinBackoff.
        var jittered = Math.Max(MinBackoff.TotalSeconds, capped * nextDouble());
        return TimeSpan.FromSeconds(jittered);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (string.IsNullOrEmpty(_options.Host))
        {
            _logger.LogWarning("Mqtt:Host is empty — ingest disabled; healthz will report MQTT disconnected.");
            return;
        }

        var attempt = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                _logger.LogInformation("MQTT connecting to {Host}:{Port} topic {Topic}",
                    _options.Host, _options.Port, _options.Topic);
                await _transport.ConnectAsync(stoppingToken);
                await _transport.SubscribeAsync(_options.Topic, 0, stoppingToken);
                _status.MarkConnected();
                attempt = 0;
                _logger.LogInformation("MQTT connected and subscribed to {Topic}", _options.Topic);

                // Stay parked while connected; the transport pushes messages via the event.
                while (_transport.IsConnected && !stoppingToken.IsCancellationRequested)
                    await Task.Delay(TimeSpan.FromSeconds(1), _time, stoppingToken);

                _logger.LogWarning("MQTT connection lost; will reconnect.");
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "MQTT connect/subscribe failed (attempt {Attempt})", attempt + 1);
            }
            finally
            {
                _status.MarkDisconnected();
            }

            if (stoppingToken.IsCancellationRequested)
                break;

            var delay = ComputeBackoff(attempt, Random.Shared.NextDouble);
            attempt++;
            try
            {
                await Task.Delay(delay, _time, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private Task OnMessageAsync(MqttMessage message)
    {
        try
        {
            var (now, aircraft) = Dump1090Parser.Parse(message.Payload.Span);
            _store.ApplyUpdates(aircraft);
            _status.MarkMessage(_time.GetUtcNow(), aircraft.Count, now);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to parse aircraft.json payload ({Bytes} bytes)", message.Payload.Length);
        }

        return Task.CompletedTask;
    }
}
