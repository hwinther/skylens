using System.Globalization;
using Microsoft.Extensions.Options;
using Skylens.Api.Options;

namespace Skylens.Api.Enrichment;

/// <summary>
///     ADSBx (RapidAPI) point-radius away-mode source, tagged <c>src:"adsbx"</c>. Paid with a small monthly
///     <see cref="UpstreamBudget" />, so it is only the fallback behind adsb.lol (see
///     <see cref="Broadcast.AwayModeChain" />) and only active when a RapidAPI key is configured. Cell
///     caching, single-flight and failure caching live in <see cref="ReadsbPointSource" />.
/// </summary>
public sealed class AdsbxClient : ReadsbPointSource
{
    private readonly AdsbxOptions _options;

    public AdsbxClient(
        HttpClient http,
        IOptions<AdsbxOptions> options,
        [FromKeyedServices("adsbx")] UpstreamBudget budget,
        TimeProvider time,
        ILogger<AdsbxClient> logger)
        : base(http, budget, time, logger)
    {
        _options = options.Value;
    }

    protected override string SourceTag => "adsbx";

    public override bool Configured => !string.IsNullOrEmpty(_options.RapidApiKey);

    protected override HttpRequestMessage BuildRequest(double lat, double lon, double radiusNm)
    {
        // RapidAPI ADSBx point-radius uses nautical miles.
        var url = string.Format(
            CultureInfo.InvariantCulture,
            "https://{0}/v2/lat/{1:0.####}/lon/{2:0.####}/dist/{3:0.##}/",
            _options.RapidApiHost, lat, lon, radiusNm);
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.TryAddWithoutValidation("X-RapidAPI-Key", _options.RapidApiKey);
        req.Headers.TryAddWithoutValidation("X-RapidAPI-Host", _options.RapidApiHost);
        return req;
    }
}
