using System.Security.Claims;

namespace Skylens.Api.Endpoints;

/// <summary>Small helpers to pull the RFC 9068 claims we care about off the caller's principal.</summary>
internal static class UserClaims
{
    public static string? Sub(this ClaimsPrincipal user) =>
        user.FindFirst("sub")?.Value ?? user.FindFirst(ClaimTypes.NameIdentifier)?.Value;

    public static string? PreferredUsername(this ClaimsPrincipal user) =>
        user.FindFirst("preferred_username")?.Value;

    public static string[] Groups(this ClaimsPrincipal user) =>
        user.FindAll("groups").Select(static c => c.Value).ToArray();
}
