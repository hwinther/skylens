using Skylens.Api.Enrichment;

namespace Skylens.Api.Broadcast;

/// <summary>
///     The away-mode source the broadcaster and <c>/api/area</c> use: tries each configured provider in
///     order (adsb.lol first, then ADSBx when a key is set) and returns the first that answers without a
///     status reason. When none can, the first configured provider's reason is surfaced (that's the
///     one the operator actually relies on); with nothing configured at all, "away-mode-unconfigured".
/// </summary>
public sealed class AwayModeChain : IAwayModeSource
{
    private readonly IReadOnlyList<ReadsbPointSource> _sources;

    public AwayModeChain(IEnumerable<ReadsbPointSource> sources)
    {
        _sources = sources.ToList();
    }

    public async Task<AwayModeResult> GetAsync(double lat, double lon, double radiusKm, CancellationToken ct)
    {
        string? firstReason = null;
        foreach (var source in _sources)
        {
            if (!source.Configured)
                continue;
            var result = await source.GetAsync(lat, lon, radiusKm, ct);
            if (result.StatusReason is null)
                return result;
            firstReason ??= result.StatusReason;
        }

        return new AwayModeResult([], firstReason ?? "away-mode-unconfigured");
    }
}
