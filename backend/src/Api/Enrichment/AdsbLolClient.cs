using System.Globalization;
using Microsoft.Extensions.Options;
using Skylens.Api.Options;

namespace Skylens.Api.Enrichment;

/// <summary>
///     adsb.lol point-radius away-mode source, tagged <c>src:"adsblol"</c>. Free and keyless (data is
///     ODbL, so the app credits it), which makes it the primary away-mode source. Fair use is enforced by
///     the shared cell caching in <see cref="ReadsbPointSource" /> plus a generous daily
///     <see cref="UpstreamBudget" /> that still fails closed. Disable with <c>AdsbLol:Enabled=false</c>.
/// </summary>
public sealed class AdsbLolClient : ReadsbPointSource
{
    private readonly AdsbLolOptions _options;

    public AdsbLolClient(
        HttpClient http,
        IOptions<AdsbLolOptions> options,
        [FromKeyedServices("adsblol")] UpstreamBudget budget,
        TimeProvider time,
        ILogger<AdsbLolClient> logger)
        : base(http, budget, time, logger)
    {
        _options = options.Value;
    }

    protected override string SourceTag => "adsblol";

    public override bool Configured => _options.Enabled && !string.IsNullOrEmpty(_options.BaseUrl);

    protected override HttpRequestMessage BuildRequest(double lat, double lon, double radiusNm)
    {
        // /v2/point/{lat}/{lon}/{radius} — radius in nautical miles, 250 max.
        var url = string.Format(
            CultureInfo.InvariantCulture,
            "{0}/v2/point/{1:0.####}/{2:0.####}/{3:0.##}",
            _options.BaseUrl.TrimEnd('/'), lat, lon, radiusNm);
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        // adsb.lol asks API users to identify themselves.
        req.Headers.TryAddWithoutValidation("User-Agent", "Skylens (+https://skylens.wsh.no)");
        return req;
    }
}
