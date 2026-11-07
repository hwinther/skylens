using System.Globalization;
using Microsoft.Extensions.Options;
using Skylens.Api.Options;

namespace Skylens.Api.Enrichment;

/// <summary>
///     adsb.fi open-data point-radius away-mode source, tagged <c>src:"adsbfi"</c>. Free and keyless for
///     personal, non-commercial use; the terms require citing adsb.fi with a link (the app does, on every
///     aircraft it served). ADSBx-v2-compatible JSON, rate limited to 1 request/s — hence
///     <see cref="MinRequestSpacing" />. Second free fallback in <see cref="Broadcast.AwayModeChain" />;
///     caching, single-flight and the fail-closed daily budget come from <see cref="ReadsbPointSource" />.
///     Disable with <c>AdsbFi:Enabled=false</c>.
/// </summary>
public sealed class AdsbFiClient : ReadsbPointSource
{
    private readonly AdsbFiOptions _options;

    public AdsbFiClient(
        HttpClient http,
        IOptions<AdsbFiOptions> options,
        [FromKeyedServices("adsbfi")] UpstreamBudget budget,
        TimeProvider time,
        ILogger<AdsbFiClient> logger)
        : base(http, budget, time, logger)
    {
        _options = options.Value;
    }

    protected override string SourceTag => "adsbfi";

    public override bool Configured => _options.Enabled && !string.IsNullOrEmpty(_options.BaseUrl);

    /// <summary>Published limit is 1 request/s; a little slack on top.</summary>
    protected override TimeSpan MinRequestSpacing => TimeSpan.FromMilliseconds(1100);

    protected override HttpRequestMessage BuildRequest(double lat, double lon, double radiusNm)
    {
        // /api/v2/lat/{lat}/lon/{lon}/dist/{dist} — distance in nautical miles, 250 max.
        var url = string.Format(
            CultureInfo.InvariantCulture,
            "{0}/api/v2/lat/{1:0.####}/lon/{2:0.####}/dist/{3:0.##}",
            _options.BaseUrl.TrimEnd('/'), lat, lon, radiusNm);
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.TryAddWithoutValidation("User-Agent", "Skylens (+https://skylens.wsh.no)");
        return req;
    }
}
