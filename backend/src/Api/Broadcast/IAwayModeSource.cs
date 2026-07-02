using Skylens.Api.State;

namespace Skylens.Api.Broadcast;

/// <summary>Result of an away-mode lookup: either aircraft, or a status reason (e.g. budget exhausted).</summary>
public sealed record AwayModeResult(IReadOnlyList<AircraftDto> Aircraft, string? StatusReason)
{
    public static readonly AwayModeResult Empty = new([], null);
}

/// <summary>
///     Supplies ADSBx-sourced snapshots for viewers outside the home feed's coverage. Grid-cell
///     bucketed + budget-limited behind the implementation; the broadcaster just asks per viewer.
/// </summary>
public interface IAwayModeSource
{
    Task<AwayModeResult> GetAsync(double lat, double lon, double radiusKm, CancellationToken ct);
}
