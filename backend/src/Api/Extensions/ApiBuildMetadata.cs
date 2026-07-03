using System.Reflection;
using System.Text;

namespace Skylens.Api.Extensions;

/// <summary>
///     Reads version info baked in at publish and surfaces it to <c>/api/version</c>, <c>/healthz</c>,
///     and the OpenAPI document. The Docker build passes <c>-p:InformationalVersion="&lt;semver&gt;"</c>
///     and <c>-p:SourceRevisionId="&lt;sha&gt;"</c>; the SDK then rewrites the informational version to
///     <c>&lt;semver&gt;+&lt;sha&gt;</c>, which we split on '+'. In local dev (no baked props) the
///     informational version has no '+' suffix — <see cref="Version" /> degrades to the assembly default
///     (e.g. "1.0.0") and <see cref="Sha" /> to an empty string.
/// </summary>
internal static class ApiBuildMetadata
{
    /// <summary>Semantic version, e.g. "1.2.3". Empty only when the assembly carries no informational version.</summary>
    public static string Version { get; }

    /// <summary>Full git sha, or an empty string when not baked in (local dev).</summary>
    public static string Sha { get; }

    static ApiBuildMetadata()
    {
        var asm = Assembly.GetExecutingAssembly();
        var informational = asm.GetCustomAttribute<AssemblyInformationalVersionAttribute>()
                               ?.InformationalVersion;

        var (semver, commitFromInfo) = ParseInformationalVersion(informational);
        var commit = !string.IsNullOrWhiteSpace(commitFromInfo)
            ? commitFromInfo
            : GetSourceRevisionId(asm);

        Version = semver;
        Sha = commit ?? string.Empty;
    }

    public static string BuildOpenApiDescription(string introduction)
    {
        var sb = new StringBuilder();
        sb.AppendLine(introduction.TrimEnd());
        sb.AppendLine();
        sb.AppendLine("---");
        sb.AppendLine();

        if (!string.IsNullOrWhiteSpace(Version))
        {
            sb.Append("**Version:** `");
            sb.Append(Version);
            sb.AppendLine("`");
        }

        if (!string.IsNullOrWhiteSpace(Sha))
        {
            sb.Append("**Git SHA:** `");
            sb.Append(Sha);
            sb.AppendLine("`");
        }

        return sb.ToString()
                 .Replace("\r\n", "\n")
                 .TrimEnd();
    }

    private static (string SemVer, string? Commit) ParseInformationalVersion(string? informational)
    {
        if (string.IsNullOrWhiteSpace(informational))
            return ("", null);

        var trimmed = informational.Trim();
        var plus = trimmed.IndexOf('+');
        if (plus < 0)
            return (trimmed, null);

        var semver = trimmed[..plus]
            .Trim();

        var commit = trimmed[(plus + 1)..]
            .Trim();

        return (semver, string.IsNullOrEmpty(commit) ? null : commit);
    }

    private static string? GetSourceRevisionId(Assembly asm)
    {
        foreach (var meta in asm.GetCustomAttributes<AssemblyMetadataAttribute>())
        {
            if (string.Equals(meta.Key, "SourceRevisionId", StringComparison.OrdinalIgnoreCase))
                return string.IsNullOrWhiteSpace(meta.Value) ? null : meta.Value.Trim();
        }

        return null;
    }
}
