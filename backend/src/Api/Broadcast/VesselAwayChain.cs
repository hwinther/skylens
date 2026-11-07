using Skylens.Api.State;

namespace Skylens.Api.Broadcast;

/// <summary>
///     The vessel away-mode source the broadcaster uses: BarentsWatch (official Norwegian AIS) first, then
///     aisstream.io for everywhere else. Unlike the aircraft chain, an EMPTY answer also falls through:
///     BarentsWatch answers "no vessels, no error" for any point outside Norwegian waters, which would
///     otherwise hide the global source. The first source with vessels wins; with none, an error-free
///     empty answer beats a reason (a quiet sea isn't a fault), and otherwise the first reason is surfaced.
/// </summary>
public sealed class VesselAwayChain : IVesselAwayModeSource
{
    private readonly IReadOnlyList<IVesselAwayModeSource> _sources;

    public VesselAwayChain(IEnumerable<IVesselAwayModeSource> sources)
    {
        _sources = sources.ToList();
    }

    public async Task<VesselAwayResult> GetAsync(double lat, double lon, double radiusKm, CancellationToken ct)
    {
        string? firstReason = null;
        var quiet = false;
        foreach (var source in _sources)
        {
            var result = await source.GetAsync(lat, lon, radiusKm, ct);
            if (result.Vessels.Count > 0)
                return result;
            if (result.Reason is null)
                quiet = true;
            else
                firstReason ??= result.Reason;
        }

        return quiet ? VesselAwayResult.Empty : new VesselAwayResult([], firstReason);
    }
}
