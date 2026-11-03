using System.Text.Json;

namespace Skylens.Api.Security;

/// <summary>One CSP violation, normalized from either report format.</summary>
internal sealed record CspReport(
    string BlockedUri,
    string Disposition,
    string DocumentUri,
    string EffectiveDirective,
    string? SourceFile = null,
    long? LineNumber = null,
    long? ColumnNumber = null,
    string? Sample = null);

/// <summary>
/// Receives Content-Security-Policy violation reports from browsers (see <see cref="SecurityHeaders"/>).
/// </summary>
/// <remarks>
/// Each report is logged on the <see cref="LoggerCategory"/> category with <c>csp.*</c> attributes and
/// <c>event.name=csp.violation</c>; Program.cs exports logs over OTLP, so the reports reach Loki and
/// the CSP violations dashboard in proxmox. Anonymous (the fallback policy would 401 it) and left out
/// of openapi.json. The endpoint is public by necessity (a report
/// arrives without a session), so a request is capped: body size, reports per request, string length.
/// Query strings and fragments are dropped, since they can carry tokens.
/// </remarks>
internal static class CspReports
{
    public const string LoggerCategory = "Skylens.Api.Csp";
    public const int MaxReportBytes = 64 * 1024;
    private const int MaxReports = 20;
    private const int MaxString = 512;

    public static IEndpointRouteBuilder MapCspReports(this IEndpointRouteBuilder app)
    {
        app.MapPost(SecurityHeaders.ReportPath, async (HttpRequest request, ILoggerFactory loggerFactory, CancellationToken ct) =>
        {
            if (request.ContentLength > MaxReportBytes)
                return Results.NoContent();

            using var reader = new StreamReader(request.Body);
            var buffer = new char[MaxReportBytes + 1];
            var read = await reader.ReadBlockAsync(buffer, ct);
            if (read <= MaxReportBytes)
            {
                Emit(loggerFactory.CreateLogger(LoggerCategory), Parse(new string(buffer, 0, read)),
                    request.Headers.UserAgent.FirstOrDefault());
            }
            return Results.NoContent();
        }).AllowAnonymous().ExcludeFromDescription();
        app.MapGet(SecurityHeaders.ReportPath, () => Results.StatusCode(StatusCodes.Status405MethodNotAllowed))
           .AllowAnonymous().ExcludeFromDescription();
        return app;
    }

    /// <summary>
    /// Parses a CSP report body. report-uri sends <c>{"csp-report": {...}}</c> as application/csp-report;
    /// report-to sends an array of <c>{"type": "csp-violation", "body": {...}}</c> as
    /// application/reports+json. Anything else, or malformed, yields no reports.
    /// </summary>
    public static IReadOnlyList<CspReport> Parse(string body)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(body);
        }
        catch (JsonException)
        {
            return [];
        }

        using (document)
        {
            var root = document.RootElement;
            var raws = new List<JsonElement>();
            if (root.ValueKind == JsonValueKind.Array)
            {
                foreach (var entry in root.EnumerateArray())
                {
                    if (entry.ValueKind == JsonValueKind.Object
                        && Text(entry, "type") == "csp-violation"
                        && entry.TryGetProperty("body", out var reportBody)
                        && reportBody.ValueKind == JsonValueKind.Object)
                        raws.Add(reportBody);
                }
            }
            else if (root.ValueKind == JsonValueKind.Object
                     && root.TryGetProperty("csp-report", out var report)
                     && report.ValueKind == JsonValueKind.Object)
            {
                raws.Add(report);
            }

            return raws.Take(MaxReports).Select(Normalize).OfType<CspReport>().ToList();
        }
    }

    /// <summary>Logs each report as one <c>csp.violation</c> record.</summary>
    public static void Emit(ILogger logger, IEnumerable<CspReport> reports, string? userAgent)
    {
        // Every attribute is a template hole: Program.cs exports logs without IncludeScopes, so values in
        // a logging scope would never reach Loki. Two templates, so a report without a source location
        // doesn't carry empty source attributes.
        var agent = string.IsNullOrEmpty(userAgent) ? "unknown" : Truncate(userAgent);
        foreach (var report in reports)
        {
            if (report.SourceFile is null)
                logger.LogWarning(
                    "{event.name} {csp.disposition}: {csp.effective_directive} {csp.blocked_uri} on {csp.document_uri}"
                    + " ({user_agent.original})",
                    "csp.violation", report.Disposition, report.EffectiveDirective, report.BlockedUri,
                    report.DocumentUri, agent);
            else
                logger.LogWarning(
                    "{event.name} {csp.disposition}: {csp.effective_directive} {csp.blocked_uri} on {csp.document_uri}"
                    + " from {csp.source_file}:{csp.line_number}:{csp.column_number} {csp.sample} ({user_agent.original})",
                    "csp.violation", report.Disposition, report.EffectiveDirective, report.BlockedUri,
                    report.DocumentUri, report.SourceFile, report.LineNumber, report.ColumnNumber, report.Sample, agent);
        }
    }

    private static CspReport? Normalize(JsonElement raw)
    {
        // report-uri (Firefox) uses kebab-case, report-to (Chromium) camelCase.
        var directive = Text(raw, "effectiveDirective") ?? Text(raw, "effective-directive") ?? Text(raw, "violated-directive");
        var document = WithoutQuery(Text(raw, "documentURL") ?? Text(raw, "document-uri"));
        if (directive is null || document is null)
            return null;

        return new CspReport(
            BlockedUri: WithoutQuery(Text(raw, "blockedURL") ?? Text(raw, "blocked-uri")) ?? string.Empty,
            Disposition: Text(raw, "disposition") ?? "unknown",
            DocumentUri: document,
            EffectiveDirective: directive,
            SourceFile: WithoutQuery(Text(raw, "sourceFile") ?? Text(raw, "source-file")),
            LineNumber: Number(raw, "lineNumber") ?? Number(raw, "line-number"),
            ColumnNumber: Number(raw, "columnNumber") ?? Number(raw, "column-number"),
            Sample: Text(raw, "sample") ?? Text(raw, "script-sample"));
    }

    private static string? Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            && value.GetString() is { Length: > 0 } text
            ? Truncate(text)
            : null;

    private static long? Number(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt64(out var number)
            ? number
            : null;

    private static string Truncate(string text) => text.Length > MaxString ? text[..MaxString] + "…" : text;

    private static string? WithoutQuery(string? uri)
    {
        if (uri is null || !Uri.TryCreate(uri, UriKind.Absolute, out var parsed) || string.IsNullOrEmpty(parsed.Host))
            return uri; // Not a URL: 'inline', 'eval', 'data', a bare scheme.
        return parsed.GetLeftPart(UriPartial.Path);
    }
}
