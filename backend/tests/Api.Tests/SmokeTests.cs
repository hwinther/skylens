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
    public async Task Healthz_includes_the_ais_fields_and_status_stays_aircraft_only()
    {
        // The AIS vertical extends the payload ADDITIVELY: the Ais* fields must be present on both the
        // real-JwtBearer and DevAuth boots, and — critically — the top-level "status" must stay driven by
        // the aircraft feed alone (no broker in-test ⇒ "degraded"), never influenced by the AIS fields.
        foreach (var factory in new WebApplicationFactory<Program>[] { _factory, _authFactory })
        {
            using var client = factory.CreateClient();
            using var resp = await client.GetAsync("/healthz", TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.OK, resp.StatusCode);

            var body = await resp.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;

            Assert.Equal("degraded", root.GetProperty("status").GetString());
            Assert.True(root.TryGetProperty("aisConnected", out var aisConnected));
            Assert.Equal(JsonValueKind.False, aisConnected.ValueKind); // no broker reachable in-test
            Assert.True(root.TryGetProperty("vesselCount", out var vesselCount));
            Assert.Equal(0, vesselCount.GetInt32());
            Assert.True(root.TryGetProperty("aisLastMessageAgeSeconds", out var aisAge));
            Assert.Equal(JsonValueKind.Null, aisAge.ValueKind); // no AIS message has ever arrived
            Assert.True(root.TryGetProperty("aisStale", out var aisStale));
            Assert.True(aisStale.GetBoolean()); // never-seen feed is stale
        }
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
    public async Task Static_files_are_served_anonymously()
    {
        using var client = _factory.CreateClient();

        // A real file with an extension matches NO endpoint (the SPA fallback's {*path:nonfile}
        // constraint excludes file-like paths), so only the static-file middleware can serve it — and
        // that middleware must run BEFORE auth: the fallback authorization policy applies to
        // non-endpoint requests that reach middleware behind UseAuthorization. This is exactly how the
        // hashed /_expo assets and favicon 401'd in production while preview's DevAuth masked it.
        using var resp = await client.GetAsync("/index.html", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.StartsWith("text/html", resp.Content.Headers.ContentType?.ToString());
    }

    [Fact]
    public async Task Missing_static_assets_return_404_not_401()
    {
        using var client = _factory.CreateClient();

        // A miss under the bundle's static roots must be a plain 404. Without the short-circuit in
        // Program.cs it would fall past UseStaticFiles into endpoint routing, match no endpoint, and
        // the fallback authorization policy would 401 it — masking "file missing from wwwroot" as an
        // auth failure (exactly how the fonts stripped by publish's node_modules exclusion surfaced).
        using var assets = await client.GetAsync("/assets/definitely-missing.ttf", TestContext.Current.CancellationToken);
        using var expo = await client.GetAsync("/_expo/static/js/web/missing.js", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, assets.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, expo.StatusCode);
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
    public async Task Api_vessels_requires_authentication()
    {
        using var client = _factory.CreateClient();

        using var resp = await client.GetAsync("/api/vessels", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task Api_vessel_detail_requires_authentication()
    {
        using var client = _factory.CreateClient();

        using var resp = await client.GetAsync("/api/vessels/257249000", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task Api_satellites_requires_authentication()
    {
        using var client = _factory.CreateClient();

        using var resp = await client.GetAsync("/api/satellites", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task Api_satellite_detail_requires_authentication()
    {
        using var client = _factory.CreateClient();

        using var resp = await client.GetAsync("/api/satellites/25544", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task Api_satellites_returns_the_fixture_snapshot_when_authenticated()
    {
        using var client = _authFactory.CreateClient();

        // DevAuthFactory runs in Development, so the Satellites:TleFile / TransmittersFile fixtures load
        // (no network). The snapshot dedupes ISS across stations+amateur → 21 distinct satellites.
        using var resp = await client.GetAsync("/api/satellites", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;

        Assert.True(root.TryGetProperty("fetchedAtUtc", out _));
        Assert.True(root.TryGetProperty("tleAgeSeconds", out _));
        var satellites = root.GetProperty("satellites");
        Assert.Equal(JsonValueKind.Array, satellites.ValueKind);
        Assert.True(satellites.GetArrayLength() > 15, "expected the fixture's >15 satellites");

        // ISS (25544) must be present, deduped to the higher-precedence "stations" group, and carry a
        // non-null SatNOGS downlink summary joined from the transmitters fixture.
        JsonElement iss = default;
        var found = false;
        foreach (var sat in satellites.EnumerateArray())
        {
            if (sat.GetProperty("noradId").GetInt32() == 25544)
            {
                iss = sat;
                found = true;
                break;
            }
        }

        Assert.True(found, "ISS (25544) missing from the satellite list");
        Assert.Equal("stations", iss.GetProperty("group").GetString());
        Assert.Equal(JsonValueKind.String, iss.GetProperty("freqSummary").ValueKind);
        Assert.False(string.IsNullOrEmpty(iss.GetProperty("freqSummary").GetString()));

        // The raw OMM elements round-trip with their VERBATIM uppercase CelesTrak keys (the client feeds
        // them straight into satellite.js json2satrec).
        var omm = iss.GetProperty("omm");
        Assert.Equal(25544, omm.GetProperty("NORAD_CAT_ID").GetInt32());
        Assert.True(omm.TryGetProperty("OBJECT_NAME", out _));
        Assert.True(omm.TryGetProperty("MEAN_MOTION", out _));
    }

    [Fact]
    public async Task Api_satellite_detail_returns_transmitters_for_the_iss()
    {
        using var client = _authFactory.CreateClient();

        using var resp = await client.GetAsync("/api/satellites/25544", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;

        Assert.Equal(25544, root.GetProperty("satellite").GetProperty("noradId").GetInt32());
        var transmitters = root.GetProperty("transmitters");
        Assert.Equal(JsonValueKind.Array, transmitters.ValueKind);
        Assert.True(transmitters.GetArrayLength() > 0, "ISS should have transmitters in the fixture");
    }

    [Fact]
    public async Task Api_satellite_detail_returns_404_for_unknown_norad_id()
    {
        using var client = _authFactory.CreateClient();

        // A NORAD id the snapshot has never seen → 404 (same shape as an unknown aircraft hex / MMSI).
        using var resp = await client.GetAsync("/api/satellites/99999999", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task Healthz_includes_the_satellite_fields_on_both_factories_without_triggering_a_fetch()
    {
        // The satellite vertical extends healthz ADDITIVELY. On SkylensFactory (Testing env, no fixtures,
        // no fetch) the fields must reflect a never-fetched snapshot — count 0 / age null / stale true —
        // and, critically, reading them on healthz must NOT trigger the lazy CelesTrak fetch (a probe stays
        // cheap and offline-safe). The DevAuth boot must also carry the three fields.
        foreach (var factory in new WebApplicationFactory<Program>[] { _factory, _authFactory })
        {
            using var client = factory.CreateClient();
            using var resp = await client.GetAsync("/healthz", TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.OK, resp.StatusCode);

            var body = await resp.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;

            Assert.True(root.TryGetProperty("satelliteCount", out var satelliteCount));
            Assert.True(root.TryGetProperty("tleAgeSeconds", out _));
            Assert.True(root.TryGetProperty("tleStale", out var tleStale));

            // SkylensFactory never loads fixtures and healthz never fetches, so it always reports the
            // never-fetched shape. (DevAuth may have fetched via an earlier /api/satellites test, so only
            // the SkylensFactory invariants are asserted precisely here.)
            if (ReferenceEquals(factory, _factory))
            {
                Assert.Equal(0, satelliteCount.GetInt32());
                Assert.Equal(JsonValueKind.Null, root.GetProperty("tleAgeSeconds").ValueKind);
                Assert.True(tleStale.GetBoolean());
            }
        }
    }

    [Fact]
    public async Task Api_vessels_returns_empty_list_when_authenticated_and_no_feed()
    {
        using var client = _authFactory.CreateClient();

        // No broker in-test, so the vessel store is empty — the endpoint must still return a 200 with a
        // JSON array (empty), not a 404/500.
        using var resp = await client.GetAsync("/api/vessels", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        using var doc = JsonDocument.Parse(body);
        Assert.Equal(JsonValueKind.Array, doc.RootElement.ValueKind);
        Assert.Equal(0, doc.RootElement.GetArrayLength());
    }

    [Fact]
    public async Task Api_vessel_detail_returns_404_for_unknown_mmsi()
    {
        using var client = _authFactory.CreateClient();

        // An MMSI the store has never seen yields no state (and thus no derived metadata) → 404.
        using var resp = await client.GetAsync("/api/vessels/000000000", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
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

    [Fact]
    public async Task Every_response_carries_the_X_Skylens_Api_marker_including_on_401()
    {
        using var client = _factory.CreateClient();

        // The marker's PRESENCE is how the app distinguishes "reached the backend" from "killed at the
        // edge (CrowdSec) before Kestrel". It must land on anonymous 200s AND auth 401s alike.
        using var ok = await client.GetAsync("/healthz", TestContext.Current.CancellationToken);
        using var unauthorized = await client.GetAsync("/api/me", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, unauthorized.StatusCode);
        foreach (var resp in new[] { ok, unauthorized })
        {
            Assert.True(resp.Headers.Contains("X-Skylens-Api"), "X-Skylens-Api header is missing");
            Assert.False(string.IsNullOrEmpty(resp.Headers.GetValues("X-Skylens-Api").First()));
        }
    }

    [Fact]
    public async Task Client_log_accepts_an_anonymous_post()
    {
        using var client = _factory.CreateClient();

        // Anonymous by design: it must capture failures that happen without a token (auth / edge blocks).
        using var content = new StringContent(
            """{"entries":[{"method":"GET","endpoint":"/api/aircraft","status":403,"edgeMarkerPresent":false,"userAgent":"Skylens/0.1.0","detail":"blocked"}]}""",
            System.Text.Encoding.UTF8,
            "application/json");
        using var resp = await client.PostAsync("/api/client-log", content, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
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
