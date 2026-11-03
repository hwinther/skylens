using Xunit;
using System.Net;
using System.Text;
using Skylens.Api.Security;

namespace Skylens.Api.Tests;

/// <summary>
///     Security headers, the CSP and the anonymous /csp-report endpoint. Runs on
///     <see cref="SmokeTests.SkylensFactory" /> (real JwtBearer, no dev auth), so the report endpoint
///     answering 204 proves it is exempt from the fallback authorization policy.
/// </summary>
public sealed class SecurityTests : IClassFixture<SmokeTests.SkylensFactory>
{
    private readonly SmokeTests.SkylensFactory _factory;

    public SecurityTests(SmokeTests.SkylensFactory factory) => _factory = factory;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Responses_carry_the_security_headers_and_a_report_only_policy()
    {
        using var client = _factory.CreateClient();
        using var resp = await client.GetAsync("/healthz", Ct);

        Assert.Equal("max-age=31536000", resp.Headers.GetValues("Strict-Transport-Security").Single());
        Assert.Equal("nosniff", resp.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal("DENY", resp.Headers.GetValues("X-Frame-Options").Single());
        Assert.Equal("strict-origin-when-cross-origin", resp.Headers.GetValues("Referrer-Policy").Single());
        Assert.Equal(SecurityHeaders.ContentSecurityPolicy,
            resp.Headers.GetValues("Content-Security-Policy-Report-Only").Single());
        Assert.False(resp.Headers.Contains("Content-Security-Policy"));
        Assert.Equal("csp=\"/csp-report\"", resp.Headers.GetValues("Reporting-Endpoints").Single());
    }

    [Fact]
    public async Task The_ar_view_keeps_its_sensors_and_sign_in_keeps_its_popup_opener()
    {
        using var client = _factory.CreateClient();
        using var resp = await client.GetAsync("/healthz", Ct);

        var permissions = resp.Headers.GetValues("Permissions-Policy").Single();
        Assert.Contains("camera=(self)", permissions);
        Assert.Contains("geolocation=(self)", permissions);
        Assert.Contains("gyroscope=(self)", permissions);
        Assert.False(resp.Headers.Contains("Cross-Origin-Opener-Policy"));
    }

    [Fact]
    public async Task Swagger_ui_is_not_policed()
    {
        using var client = _factory.CreateClient();
        using var resp = await client.GetAsync("/swagger/index.html", Ct);

        Assert.False(resp.Headers.Contains("Content-Security-Policy-Report-Only"));
        Assert.True(resp.Headers.Contains("X-Content-Type-Options"));
    }

    [Fact]
    public void The_policy_keeps_scripts_to_the_site()
    {
        Assert.Contains("script-src 'self';", SecurityHeaders.ContentSecurityPolicy);
        Assert.DoesNotMatch("script-src[^;]*unsafe", SecurityHeaders.ContentSecurityPolicy);
        Assert.Contains("frame-ancestors 'none'", SecurityHeaders.ContentSecurityPolicy);
    }

    [Theory]
    [InlineData("{\"csp-report\":{\"document-uri\":\"https://x.test/\",\"effective-directive\":\"img-src\"}}")]
    [InlineData("{not json")]
    public async Task Report_endpoint_is_anonymous_and_answers_204(string body)
    {
        using var client = _factory.CreateClient();
        using var resp = await client.PostAsync("/csp-report",
            new StringContent(body, Encoding.UTF8, "application/csp-report"), Ct);

        Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
    }

    [Fact]
    public async Task Report_endpoint_refuses_get()
    {
        using var client = _factory.CreateClient();
        using var resp = await client.GetAsync("/csp-report", Ct);

        Assert.Equal(HttpStatusCode.MethodNotAllowed, resp.StatusCode);
    }

    [Fact]
    public void Parses_both_formats_and_drops_queries()
    {
        Assert.Equal(
            [new CspReport("inline", "report", "https://skylens.test/map", "script-src-elem", LineNumber: 12)],
            CspReports.Parse("""
                {"csp-report": {"blocked-uri": "inline", "disposition": "report", "line-number": 12,
                  "document-uri": "https://skylens.test/map?lat=1", "effective-directive": "script-src-elem"}}
                """));
        Assert.Equal(
            [new CspReport("https://evil.test/x.js", "enforce", "https://skylens.test/", "script-src-elem")],
            CspReports.Parse("""
                [{"type": "csp-violation", "body": {"blockedURL": "https://evil.test/x.js?t=1", "disposition": "enforce",
                   "documentURL": "https://skylens.test/", "effectiveDirective": "script-src-elem"}},
                 {"type": "deprecation", "body": {"id": "x"}}]
                """));
    }

    [Theory]
    [InlineData("{\"hello\":\"world\"}")]
    [InlineData("{\"csp-report\":{\"document-uri\":\"https://x.test/\"}}")]
    [InlineData("{\"csp-report\":{\"document-uri\":1,\"effective-directive\":\"img-src\"}}")]
    public void Yields_nothing_for_unusable_bodies(string body) => Assert.Empty(CspReports.Parse(body));
}
