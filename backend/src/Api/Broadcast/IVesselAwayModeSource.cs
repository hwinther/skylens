using Skylens.Api.State;

namespace Skylens.Api.Broadcast;

/// <summary>Result of a vessel away-mode lookup: either vessels, or a reason (e.g. budget exhausted).</summary>
public sealed record VesselAwayResult(IReadOnlyList<VesselDto> Vessels, string? Reason)
{
    public static readonly VesselAwayResult Empty = new([], null);
}

/// <summary>
///     Supplies AIS snapshots for viewers outside the home feed's coverage. Phase 5 replaces the null
///     implementation with a BarentsWatch-backed source; the broadcaster just asks per viewer. Mirrors
///     <see cref="IAwayModeSource" />.
/// </summary>
public interface IVesselAwayModeSource
{
    Task<VesselAwayResult> GetAsync(double lat, double lon, double radiusKm, CancellationToken ct);
}

/// <summary>No-op away-mode source used until Phase 5: always yields an empty list (no coverage).</summary>
public sealed class NullVesselAwayModeSource : IVesselAwayModeSource
{
    public Task<VesselAwayResult> GetAsync(double lat, double lon, double radiusKm, CancellationToken ct) =>
        Task.FromResult(VesselAwayResult.Empty);
}
