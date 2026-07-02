using Microsoft.Extensions.Options;
using MQTTnet;
using Skylens.Api.Options;

namespace Skylens.Api.Ingest;

/// <summary>
///     MQTTnet v5 implementation of <see cref="IMqttTransport" />. Wraps a raw <see cref="IMqttClient" />
///     (ManagedClient was removed in v5; the reconnect loop lives in <see cref="MqttIngestService" />).
/// </summary>
public sealed class MqttNetTransport : IMqttTransport
{
    private readonly MqttOptions _options;
    private readonly IMqttClient _client;

    public MqttNetTransport(IOptions<MqttOptions> options)
    {
        _options = options.Value;
        _client = new MqttClientFactory().CreateMqttClient();
        _client.ApplicationMessageReceivedAsync += async e =>
        {
            var handler = MessageReceived;
            if (handler is not null)
                await handler(new MqttMessage(
                    e.ApplicationMessage.Topic,
                    System.Buffers.BuffersExtensions.ToArray(e.ApplicationMessage.Payload)));
        };
    }

    public event Func<MqttMessage, Task>? MessageReceived;

    public bool IsConnected => _client.IsConnected;

    public async Task ConnectAsync(CancellationToken ct)
    {
        var builder = new MqttClientOptionsBuilder()
                      .WithTcpServer(_options.Host, _options.Port)
                      .WithClientId($"skylens-{Environment.MachineName}-{Guid.NewGuid():N}".Substring(0, 40))
                      .WithCleanSession()
                      .WithKeepAlivePeriod(TimeSpan.FromSeconds(30));

        if (!string.IsNullOrEmpty(_options.Username))
            builder = builder.WithCredentials(_options.Username, _options.Password ?? string.Empty);

        await _client.ConnectAsync(builder.Build(), ct);
    }

    public Task SubscribeAsync(string topic, int qos, CancellationToken ct)
    {
        var options = new MqttClientSubscribeOptionsBuilder()
                      .WithTopicFilter(topic, (MQTTnet.Protocol.MqttQualityOfServiceLevel)qos)
                      .Build();
        return _client.SubscribeAsync(options, ct);
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (_client.IsConnected)
                await _client.DisconnectAsync();
        }
        catch
        {
            // best-effort; shutting down
        }

        _client.Dispose();
    }
}
