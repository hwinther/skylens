namespace Skylens.Api.Ingest;

/// <summary>
///     Minimal MQTT transport the ingest service drives. Abstracted so the reconnect/backoff loop in
///     <see cref="MqttIngestService" /> is unit-testable with a fake — no real broker or MQTTnet types
///     leak into the tests.
/// </summary>
public interface IMqttTransport : IAsyncDisposable
{
    /// <summary>Raised for every message on a subscribed topic (payload = raw bytes).</summary>
    event Func<MqttMessage, Task>? MessageReceived;

    /// <summary>Connect to the broker. Throws on failure (the caller's loop handles retry).</summary>
    Task ConnectAsync(CancellationToken ct);

    /// <summary>Subscribe to a topic at the given QoS.</summary>
    Task SubscribeAsync(string topic, int qos, CancellationToken ct);

    /// <summary>True while the underlying client reports a live connection.</summary>
    bool IsConnected { get; }
}

/// <summary>A received MQTT message (topic + raw UTF-8/binary payload).</summary>
public readonly record struct MqttMessage(string Topic, ReadOnlyMemory<byte> Payload);
