using Microsoft.Extensions.Options;
using Skylens.Api.Options;
using Skylens.Api.State;

namespace Skylens.Api.Ingest;

/// <summary>
///     Hand-rolled MQTT ingest: connect → subscribe <c>adsb/aircraft</c> (+ <c>ais/data</c>) QoS 0 →
///     consume → on drop, reconnect with exponential backoff (1s → 30s) + jitter. Both feeds ride the
///     one connection; each received message is dispatched by topic. MQTTnet v5 has no ManagedClient, so
///     the loop lives here and is unit-testable via <see cref="IMqttTransport" />.
/// </summary>
public sealed class MqttIngestService : BackgroundService
{
    private static readonly TimeSpan MinBackoff = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromSeconds(30);

    private readonly IMqttTransport _transport;
    private readonly MqttOptions _options;
    private readonly AircraftStateStore _store;
    private readonly IngestStatus _status;
    private readonly VesselStateStore _vesselStore;
    private readonly VesselIngestStatus _vesselStatus;
    private readonly TimeProvider _time;
    private readonly ILogger<MqttIngestService> _logger;

    public MqttIngestService(
        IMqttTransport transport,
        IOptions<MqttOptions> options,
        AircraftStateStore store,
        IngestStatus status,
        VesselStateStore vesselStore,
        VesselIngestStatus vesselStatus,
        TimeProvider time,
        ILogger<MqttIngestService> logger)
    {
        _transport = transport;
        _options = options.Value;
        _store = store;
        _status = status;
        _vesselStore = vesselStore;
        _vesselStatus = vesselStatus;
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
                // The AIS vessel feed shares this connection; re-subscribed on every reconnect too.
                if (!string.IsNullOrEmpty(_options.AisTopic))
                    await _transport.SubscribeAsync(_options.AisTopic, 0, stoppingToken);
                _status.MarkConnected();
                attempt = 0;
                _logger.LogInformation("MQTT connected and subscribed to {Topic} + {AisTopic}",
                    _options.Topic, _options.AisTopic);

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
        // Dispatch by topic: the AIS feed goes down the vessel path, everything else stays the aircraft
        // path (unchanged) — we only ever subscribe those two topics on this connection.
        if (!string.IsNullOrEmpty(_options.AisTopic) &&
            string.Equals(message.Topic, _options.AisTopic, StringComparison.Ordinal))
            HandleAisMessage(message);
        else
            HandleAircraftMessage(message);

        return Task.CompletedTask;
    }

    private void HandleAircraftMessage(MqttMessage message)
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
    }

    private void HandleAisMessage(MqttMessage message)
    {
        try
        {
            // One AIS-catcher record per message. Untracked types (base stations, etc.) parse to null;
            // the message still counts toward freshness — the feed is alive even if we don't track it.
            var vessel = AisCatcherParser.Parse(message.Payload.Span);
            if (vessel is not null)
                _vesselStore.ApplyUpdate(vessel);
            _vesselStatus.MarkMessage(_time.GetUtcNow(), _vesselStore.Count);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to parse AIS payload ({Bytes} bytes)", message.Payload.Length);
        }
    }
}
