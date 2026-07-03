using Xunit;
using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

namespace Skylens.Api.Tests;

/// <summary>
///     Boots the real app through <see cref="WebApplicationFactory{TEntryPoint}" />. The default
///     <see cref="SkylensFactory" /> is forced to the "Testing" environment so the dev-auth escape hatch
///     is OFF (it only activates in Development) — that lets us assert real JwtBearer 401s. No MQTT broker
///     is reachable, which is the point: the app must still start and serve /healthz (degraded) without
///     crashing. <see cref="DevAuthFactory" /> boots the same app in Development with Auth:Disabled=true so
///     the DevAuthHandler stamps a fixed principal — used to exercise the authenticated /api surface.
/// </summary>
public sealed class SmokeTests
    : IClassFixture<SmokeTests.SkylensFactory>, IClassFixture<SmokeTests.DevAuthFactory>
{
    private readonly SkylensFactory _factory;
    private readonly DevAuthFactory _authFactory;

    public SmokeTests(SkylensFactory factory, DevAuthFactory authFactory)
    {
        _factory = factory;
        _authFactory = authFactory;
    }

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
    public async Task Healthz_includes_running_version()
    {
        using var client = _factory.CreateClient();

        using var resp = await client.GetAsync("/healthz", TestContext.Current.CancellationToken);
        var body = await resp.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);

        using var doc = JsonDocument.Parse(body);
        Assert.True(doc.RootElement.TryGetProperty("version", out var version));
        Assert.False(string.IsNullOrEmpty(version.GetString()));
    }

    [Fact]
    public async Task Root_is_anonymous_and_serves_the_spa_shell()
    {
        using var client = _factory.CreateClient();

        using var resp = await client.GetAsync("/", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.StartsWith("text/html", resp.Content.Headers.ContentType?.ToString());
        var body = await resp.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.Contains("Skylens", body);
    }

    [Fact]
    public async Task Deep_link_serves_the_spa_shell_anonymously()
    {
        using var client = _factory.CreateClient();

        // A client-side route that has no server endpoint must fall through to the SPA shell (index.html),
        // anonymously — the fallback route carries AllowAnonymous past the fallback authorization policy.
        using var resp = await client.GetAsync("/map", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.StartsWith("text/html", resp.Content.Headers.ContentType?.ToString());
        var body = await resp.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.Contains("Skylens", body);
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

    [Fact]
    public async Task Api_version_requires_authentication()
    {
        using var client = _factory.CreateClient();

        using var resp = await client.GetAsync("/api/version", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task Api_version_returns_shape_when_authenticated()
    {
        using var client = _authFactory.CreateClient();

        using var resp = await client.GetAsync("/api/version", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        // A local build has no baked git sha, so "version" is the assembly default and "sha" is empty —
        // but both fields must always be present with the documented shape.
        Assert.True(root.TryGetProperty("version", out var version));
        Assert.False(string.IsNullOrEmpty(version.GetString()));
        Assert.True(root.TryGetProperty("sha", out var sha));
        Assert.Equal(JsonValueKind.String, sha.ValueKind);
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

    public sealed class DevAuthFactory : WebApplicationFactory<Program>
    {
        protected override IHost CreateHost(IHostBuilder builder)
        {
            // Development + Auth:Disabled=true wires DevAuthHandler, which stamps a fixed authenticated
            // principal on every request — so we can exercise the authenticated /api surface without OIDC.
            builder.UseEnvironment("Development");
            builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Auth:Disabled"] = "true",
                    ["Mqtt:Host"] = "",
                    ["Oidc:Authority"] = "https://auth.wsh.no",
                    ["Oidc:Audience"] = "skylens-api",
                }));

            return base.CreateHost(builder);
        }
    }
}
