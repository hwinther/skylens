using Xunit;
using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

namespace Skylens.Api.Tests;

/// <summary>
///     Boots the real app through <see cref="WebApplicationFactory{TEntryPoint}" />. Forced to the
///     "Testing" environment so the dev-auth escape hatch is OFF (it only activates in Development) —
///     that lets us assert real JwtBearer 401s. No MQTT broker is reachable, which is the point: the app
///     must still start and serve /healthz (degraded) without crashing.
/// </summary>
public sealed class SmokeTests : IClassFixture<SmokeTests.SkylensFactory>
{
    private readonly SkylensFactory _factory;

    public SmokeTests(SkylensFactory factory) => _factory = factory;

    [Fact]
    public async Task Healthz_is_anonymous_and_returns_200_with_no_broker()
    {
        using var client = _factory.CreateClient();

        using var resp = await client.GetAsync("/healthz", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        // No broker is reachable in-test, so the feed is degraded — but it must still respond 200.
        Assert.Contains("degraded", body);
    }

    [Fact]
    public async Task Root_is_anonymous_and_returns_html_landing_page()
    {
        using var client = _factory.CreateClient();

        using var resp = await client.GetAsync("/", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.Equal("text/html; charset=utf-8", resp.Content.Headers.ContentType?.ToString());
    }

    [Fact]
    public async Task Api_me_requires_authentication()
    {
        using var client = _factory.CreateClient();

        using var resp = await client.GetAsync("/api/me", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task Api_aircraft_requires_authentication()
    {
        using var client = _factory.CreateClient();

        using var resp = await client.GetAsync("/api/aircraft", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    public sealed class SkylensFactory : WebApplicationFactory<Program>
    {
        protected override IHost CreateHost(IHostBuilder builder)
        {
            // "Testing" is not Development, so DevAuthHandler is never wired and JwtBearer guards /api/*.
            builder.UseEnvironment("Testing");
            builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    // Keep MQTT off; the ingest service logs a warning and returns without connecting.
                    ["Mqtt:Host"] = "",
                    // A real (unreachable) Authority so JwtBearer initialises without network at startup.
                    ["Oidc:Authority"] = "https://auth.wsh.no",
                    ["Oidc:Audience"] = "skylens-api",
                }));

            return base.CreateHost(builder);
        }
    }
}
