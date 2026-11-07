using System.Globalization;
using Microsoft.Extensions.Options;
using Skylens.Api.Options;

namespace Skylens.Api.Enrichment;

/// <summary>
///     airplanes.live point-radius away-mode source, tagged <c>src:"airplaneslive"</c>. Off by default — the API
///     needs approval first (see <see cref="AirplanesLiveOptions" />). Free and keyless for
///     non-commercial use, readsb JSON like adsb.lol, rate limited to 1 request/s — hence
///     <see cref="MinRequestSpacing" />. First free fallback behind adsb.lol in
///     <see cref="Broadcast.AwayModeChain" />; cell caching, single-flight and the fail-closed daily
///     <see cref="UpstreamBudget" /> come from <see cref="ReadsbPointSource" />.
///     Enable with <c>AirplanesLive:Enabled=true</c> once access is granted.
/// </summary>
public sealed class AirplanesLiveClient : ReadsbPointSource
{
    private readonly AirplanesLiveOptions _options;

    public AirplanesLiveClient(
        HttpClient http,
        IOptions<AirplanesLiveOptions> options,
        [FromKeyedServices("airplaneslive")] UpstreamBudget budget,
        TimeProvider time,
        ILogger<AirplanesLiveClient> logger)
        : base(http, budget, time, logger)
    {
        _options = options.Value;
    }

    protected override string SourceTag => "airplaneslive";

    public override bool Configured => _options.Enabled && !string.IsNullOrEmpty(_options.BaseUrl);

    /// <summary>Published limit is 1 request/s; a little slack on top.</summary>
    protected override TimeSpan MinRequestSpacing => TimeSpan.FromMilliseconds(1100);

    protected override HttpRequestMessage BuildRequest(double lat, double lon, double radiusNm)
    {
        // /v2/point/{lat}/{lon}/{radius} — radius in nautical miles, 250 max.
        var url = string.Format(
            CultureInfo.InvariantCulture,
            "{0}/v2/point/{1:0.####}/{2:0.####}/{3:0.##}",
            _options.BaseUrl.TrimEnd('/'), lat, lon, radiusNm);
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.TryAddWithoutValidation("User-Agent", "Skylens (+https://skylens.wsh.no)");
        return req;
    }
}
