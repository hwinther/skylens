using System.Diagnostics.CodeAnalysis;
using System.Security.Claims;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.RateLimiting;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Skylens.Api.Auth;
using Skylens.Api.Broadcast;
using Skylens.Api.Endpoints;
using Skylens.Api.Enrichment;
using Skylens.Api.Extensions;
using Skylens.Api.Hubs;
using Skylens.Api.Ingest;
using Skylens.Api.Options;
using Skylens.Api.State;

var builder = WebApplication.CreateBuilder(args);
var configuration = builder.Configuration;

// -- Options -----------------------------------------------------------------------------------
builder.Services.AddOptions<OidcOptions>().Bind(configuration.GetSection(OidcOptions.SectionName));
builder.Services.AddOptions<AuthOptions>().Bind(configuration.GetSection(AuthOptions.SectionName));
builder.Services.AddOptions<MqttOptions>().Bind(configuration.GetSection(MqttOptions.SectionName));
builder.Services.AddOptions<FeedOptions>().Bind(configuration.GetSection(FeedOptions.SectionName));
builder.Services.AddOptions<OpenSkyOptions>().Bind(configuration.GetSection(OpenSkyOptions.SectionName));
builder.Services.AddOptions<AdsbxOptions>().Bind(configuration.GetSection(AdsbxOptions.SectionName));
builder.Services.AddOptions<AeroApiOptions>().Bind(configuration.GetSection(AeroApiOptions.SectionName));
builder.Services.AddOptions<AircraftDbOptions>().Bind(configuration.GetSection(AircraftDbOptions.SectionName));
builder.Services.AddOptions<AirportsOptions>().Bind(configuration.GetSection(AirportsOptions.SectionName));
builder.Services.AddOptions<BarentsWatchOptions>().Bind(configuration.GetSection(BarentsWatchOptions.SectionName));
builder.Services.AddOptions<FiskInfoOptions>().Bind(configuration.GetSection(FiskInfoOptions.SectionName));
builder.Services.AddOptions<SatellitesOptions>().Bind(configuration.GetSection(SatellitesOptions.SectionName));
builder.Services.AddOptions<CorsOptions>().Bind(configuration.GetSection(CorsOptions.SectionName));

var oidcConfig = configuration.GetSection(OidcOptions.SectionName).Get<OidcOptions>() ?? new OidcOptions();
var authConfig = configuration.GetSection(AuthOptions.SectionName).Get<AuthOptions>() ?? new AuthOptions();

// -- Authentication ----------------------------------------------------------------------------
// Dev-only escape hatch: when Auth:Disabled=true AND we're in Development, swap JwtBearer for a
// test-auth handler that stamps a fixed principal. Never honored outside Development.
var useDevAuth = builder.Environment.IsDevelopment() && authConfig.Disabled;
if (useDevAuth)
{
    builder.Services.AddAuthentication(DevAuthHandler.SchemeName)
           .AddScheme<AuthenticationSchemeOptions, DevAuthHandler>(DevAuthHandler.SchemeName, static _ => { });
}
else
{
    builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
           .AddJwtBearer(options =>
           {
               options.Authority = oidcConfig.Authority;
               options.Audience = oidcConfig.Audience;
               options.TokenValidationParameters.ValidIssuer = oidcConfig.Authority;
               // Browsers can't set Authorization headers on WebSocket upgrades, so SignalR's JS
               // client appends the token as ?access_token= on /hubs/* paths instead.
               options.Events = new JwtBearerEvents
               {
                   OnMessageReceived = ctx =>
                   {
                       var token = ctx.Request.Query["access_token"];
                       if (!string.IsNullOrEmpty(token) &&
                           ctx.HttpContext.Request.Path.StartsWithSegments("/hubs"))
                           ctx.Token = token;

                       return Task.CompletedTask;
                   }
               };
           });
}

// Fallback policy = require an authenticated user on everything not explicitly AllowAnonymous.
builder.Services.AddAuthorizationBuilder()
       .SetFallbackPolicy(new Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder()
                          .RequireAuthenticatedUser()
                          .Build());

// -- Rate limiting -----------------------------------------------------------------------------
// Partition by JWT sub (per-user quotas). 'global' = 120/min token bucket on /api/*; 'enrichment' =
// 10/min queue 0 on the AeroAPI/ADSBx endpoints. Unauthenticated callers share a single fallback bucket.
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.AddPolicy("global", httpContext =>
        RateLimitPartition.GetTokenBucketLimiter(
            PartitionKey(httpContext),
            static _ => new TokenBucketRateLimiterOptions
            {
                TokenLimit = 120,
                TokensPerPeriod = 120,
                ReplenishmentPeriod = TimeSpan.FromMinutes(1),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0,
                AutoReplenishment = true,
            }));

    options.AddPolicy("enrichment", httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            PartitionKey(httpContext),
            static _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 10,
                Window = TimeSpan.FromMinutes(1),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0,
            }));

    static string PartitionKey(HttpContext ctx) =>
        ctx.User.FindFirst("sub")?.Value
        ?? ctx.User.FindFirst(ClaimTypes.NameIdentifier)?.Value
        ?? ctx.Connection.RemoteIpAddress?.ToString()
        ?? "anonymous";
});

// -- SignalR -----------------------------------------------------------------------------------
builder.Services.AddSignalR()
       .AddJsonProtocol(static opts =>
                            opts.PayloadSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase);

// -- CORS --------------------------------------------------------------------------------------
// Off by default (the mobile app isn't a browser). When Cors:Origins is set — the react-native-web
// build / Playwright E2E — allow those origins with credentials so the SignalR hub works too.
const string WebCorsPolicy = "web";
var corsOrigins = (configuration.GetSection(CorsOptions.SectionName).Get<CorsOptions>() ?? new CorsOptions())
    .ParsedOrigins();
if (corsOrigins.Length > 0)
    builder.Services.AddCors(options =>
        options.AddPolicy(WebCorsPolicy, policy =>
            policy.WithOrigins(corsOrigins)
                  .AllowAnyHeader()
                  .AllowAnyMethod()
                  .AllowCredentials()));

// -- Core state + ingest -----------------------------------------------------------------------
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<IngestStatus>();
builder.Services.AddSingleton<ViewerRegistry>();
builder.Services.AddSingleton<AircraftStateStore>();
builder.Services.AddHostedService(static sp => sp.GetRequiredService<AircraftStateStore>());

// AIS vessel domain: a second state store fed from the same MQTT connection (ais/data topic).
builder.Services.AddSingleton<VesselIngestStatus>();
builder.Services.AddSingleton<VesselStateStore>();
builder.Services.AddHostedService(static sp => sp.GetRequiredService<VesselStateStore>());
// Vessel away-mode is served by the BarentsWatch client (registered in the Enrichment section below); an
// unconfigured client fails closed to an empty list + reason, exactly like the ADSBx aircraft source.

// Dev/E2E: replay a captured aircraft.json through the real pipeline instead of a broker. Gated on
// Development so production can never be fed fabricated aircraft (mirrors the DevAuth gate).
var mqttConfig = configuration.GetSection(MqttOptions.SectionName).Get<MqttOptions>() ?? new MqttOptions();
if (builder.Environment.IsDevelopment() && mqttConfig.Replay)
    builder.Services.AddSingleton<IMqttTransport, ReplayMqttTransport>();
else
    builder.Services.AddSingleton<IMqttTransport, MqttNetTransport>();
builder.Services.AddHostedService<MqttIngestService>();
builder.Services.AddHostedService<SnapshotBroadcaster>();
// Parallel push loop for the AIS vertical; emits only "vessels" frames on the same hub.
builder.Services.AddHostedService<VesselBroadcaster>();

// -- Enrichment --------------------------------------------------------------------------------
builder.Services.AddMemoryCache();
builder.Services.AddSingleton<EnrichmentCache>();

// Offline aircraft DB (FrozenDictionary loaded in the background at startup).
builder.Services.AddSingleton<AircraftDbService>();
builder.Services.AddHostedService(static sp => sp.GetRequiredService<AircraftDbService>());

// Offline airports DB (OurAirports CSVs joined into an immutable array in the background at startup).
builder.Services.AddSingleton<AirportDbService>();
builder.Services.AddHostedService(static sp => sp.GetRequiredService<AirportDbService>());

// Per-provider budgets: ADSBx monthly, AeroAPI daily. Keyed so the clients pull the right one.
builder.Services.AddKeyedSingleton("adsbx", static (sp, _) =>
    UpstreamBudget.Monthly(
        sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<AdsbxOptions>>().Value.MonthlyBudget,
        sp.GetRequiredService<TimeProvider>()));
builder.Services.AddKeyedSingleton("aeroapi", static (sp, _) =>
    UpstreamBudget.Daily(
        sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<AeroApiOptions>>().Value.DailyBudget,
        sp.GetRequiredService<TimeProvider>()));
// BarentsWatch (vessel away-mode + detail enrichment): daily budget, shared across every client instance.
builder.Services.AddKeyedSingleton("barentswatch", static (sp, _) =>
    UpstreamBudget.Daily(
        sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<BarentsWatchOptions>>().Value.DailyBudget,
        sp.GetRequiredService<TimeProvider>()));
// FiskInfo (fishing mode: regulation zones + lost gear + ship-register enrichment): daily budget.
builder.Services.AddKeyedSingleton("fiskinfo", static (sp, _) =>
    UpstreamBudget.Daily(
        sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<FiskInfoOptions>>().Value.DailyBudget,
        sp.GetRequiredService<TimeProvider>()));
// Satellites vertical: CelesTrak TLE + SatNOGS transmitters, each with its own key-less daily budget.
builder.Services.AddKeyedSingleton("celestrak", static (sp, _) =>
    UpstreamBudget.Daily(
        sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<SatellitesOptions>>().Value.CelestrakDailyBudget,
        sp.GetRequiredService<TimeProvider>()));
builder.Services.AddKeyedSingleton("satnogs", static (sp, _) =>
    UpstreamBudget.Daily(
        sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<SatellitesOptions>>().Value.SatNogsDailyBudget,
        sp.GetRequiredService<TimeProvider>()));

builder.Services.AddHttpClient<OpenSkyMetadataClient>();
builder.Services.AddHttpClient<AdsbxClient>();
builder.Services.AddHttpClient<AeroApiClient>();
builder.Services.AddHttpClient<BarentsWatchClient>();
builder.Services.AddSingleton<MetadataService>();

// CelesTrak + SatNOGS are polite public APIs, so identify ourselves and cap the timeout. These are
// NAMED clients (not typed) because the two satellite services are process-wide singletons that hold
// a shared snapshot — a typed client would register the service transient and lose that state.
var satUserAgent = $"skylens/{(string.IsNullOrWhiteSpace(ApiBuildMetadata.Version) ? "dev" : ApiBuildMetadata.Version)}";
builder.Services.AddHttpClient("celestrak", client =>
{
    client.Timeout = TimeSpan.FromSeconds(30);
    client.DefaultRequestHeaders.UserAgent.ParseAdd(satUserAgent);
});
builder.Services.AddHttpClient("satnogs", client =>
{
    client.Timeout = TimeSpan.FromSeconds(30);
    client.DefaultRequestHeaders.UserAgent.ParseAdd(satUserAgent);
});
builder.Services.AddSingleton<CelestrakTleService>();
builder.Services.AddSingleton<SatNogsClient>();

// FiskInfo (fishing mode) — a PLAIN SINGLETON over a NAMED client so its cached OAuth token + dataset
// snapshots survive (a typed client would register the service transient and lose that state, exactly
// like the satellite services above).
builder.Services.AddHttpClient("fiskinfo", client => client.Timeout = TimeSpan.FromSeconds(30));
builder.Services.AddSingleton<FiskInfoClient>();

// The away-mode source the broadcaster consumes is the ADSBx client. HttpClient-typed clients are
// registered transient, so resolve the same instance the DI container builds for AdsbxClient.
builder.Services.AddSingleton<IAwayModeSource>(static sp => sp.GetRequiredService<AdsbxClient>());
// Vessel away-mode is the BarentsWatch client (same transient-typed-client resolve pattern as ADSBx).
builder.Services.AddSingleton<IVesselAwayModeSource>(static sp => sp.GetRequiredService<BarentsWatchClient>());

// -- Observability -----------------------------------------------------------------------------
const string serviceName = "Skylens.Api";

var exportToOtlp = !builder.Environment.IsDevelopment()
                   || !string.IsNullOrWhiteSpace(configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]);
var otlpEndpoint = configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]?.Trim() ?? "http://localhost:4317";

if (exportToOtlp)
    builder.Logging.AddOpenTelemetry(options =>
        options.SetResourceBuilder(ResourceBuilder.CreateDefault().AddService(serviceName))
               .AddOtlpExporter(otlp => otlp.Endpoint = new Uri(otlpEndpoint)));

builder.Services.AddOpenTelemetry()
       .ConfigureResource(static resource => resource.AddService(serviceName))
       .WithTracing(tracing =>
       {
           tracing.AddAspNetCoreInstrumentation(static opts =>
                                                    opts.Filter = static ctx => !ctx.Request.Path.StartsWithSegments("/healthz"))
                  .AddHttpClientInstrumentation();
           if (exportToOtlp)
               tracing.AddOtlpExporter(otlp => otlp.Endpoint = new Uri(otlpEndpoint));
       })
       .WithMetrics(metrics =>
       {
           metrics.AddAspNetCoreInstrumentation()
                  .AddHttpClientInstrumentation()
                  .AddRuntimeInstrumentation();
           if (exportToOtlp)
               metrics.AddOtlpExporter(otlp => otlp.Endpoint = new Uri(otlpEndpoint));
       });

builder.Services.AddProblemDetails();

// -- OpenAPI -----------------------------------------------------------------------------------
builder.Services.AddOpenApiDocumentation(oidcConfig);

var app = builder.Build();

// Stamp every response with the backend build version. Its PRESENCE is what tells the client the
// response actually came from Kestrel — the app's fetch wrapper treats "failed request + no
// X-Skylens-Api" as "blocked at the edge" (e.g. CrowdSec 403'ing app-shaped traffic before it
// reaches us) versus a real API/auth outcome. Registered first and via OnStarting so it lands on
// every response — 401 challenges and static files included — regardless of what produced them.
var apiVersionHeader = string.IsNullOrWhiteSpace(ApiBuildMetadata.Version) ? "dev" : ApiBuildMetadata.Version;
app.Use((context, next) =>
{
    context.Response.OnStarting(() =>
    {
        context.Response.Headers["X-Skylens-Api"] = apiVersionHeader;
        return Task.CompletedTask;
    });
    return next(context);
});

// OpenAPI (/openapi, /swagger) before auth so the docs stay anonymous.
app.UseOpenApiDocumentation(oidcConfig);

// CORS must run before auth so preflight/actual cross-origin calls to /api and /hubs are allowed.
if (corsOrigins.Length > 0)
    app.UseCors(WebCorsPolicy);

// -- SPA static files --------------------------------------------------------------------------
// The Expo web build is baked into wwwroot at image build (a placeholder index.html is committed so
// "/" still works in local dev / tests). UseDefaultFiles rewrites "/" to index.html; UseStaticFiles
// serves the hashed _expo/ assets with their default (cacheable) headers. index.html itself is served
// no-store so a new deploy is picked up immediately.
//
// ORDER IS LOAD-BEARING: static files must be served BEFORE UseAuthentication/UseAuthorization.
// Asset paths (extension ⇒ the SPA fallback's {*path:nonfile} constraint excludes them) match NO
// endpoint, and the fallback authorization policy applies to endpoint-less requests that reach any
// middleware placed after UseAuthorization — which 401'd every /_expo asset + favicon in production
// (preview's DevAuth authenticated everything and masked it). wwwroot only holds the public SPA
// bundle, so serving it pre-auth is safe. See SmokeTests.Static_files_are_served_anonymously.
app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = static ctx =>
    {
        if (string.Equals(ctx.File.Name, "index.html", StringComparison.OrdinalIgnoreCase))
            ctx.Context.Response.Headers.CacheControl = "no-store";
    },
});

// Unknown paths under the exported bundle's static roots are plain 404s. Without this, a missing
// asset sails past UseStaticFiles into endpoint routing, matches no endpoint (file-like paths are
// excluded from the SPA fallback), and the fallback authorization policy turns the miss into a
// misleading 401 challenge — exactly how the node_modules fonts dropped by publish (see Api.csproj)
// first surfaced in production.
app.Use(static (context, next) =>
{
    if (context.Request.Path.StartsWithSegments("/assets") ||
        context.Request.Path.StartsWithSegments("/_expo"))
    {
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return Task.CompletedTask;
    }
    return next(context);
});

app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();

app.MapHealthEndpoints();
app.MapApiEndpoints();
app.MapHub<AircraftHub>("/hubs/aircraft").RequireAuthorization();

// SPA fallback — any unmatched, non-file route serves the app shell for client-side routing. Real
// mapped routes (/api, /hubs, /swagger, /healthz) are matched first, so no exclusion regex is needed.
// AllowAnonymous is load-bearing: the fallback authorization policy would otherwise 401 the SPA shell.
// The fallback always serves index.html, so it's unconditionally no-store.
app.MapFallbackToFile("index.html", new StaticFileOptions
{
    OnPrepareResponse = static ctx => ctx.Context.Response.Headers.CacheControl = "no-store",
}).AllowAnonymous();

app.Run();

/// <summary>Test-visibility partial for <c>WebApplicationFactory&lt;Program&gt;</c>.</summary>
[ExcludeFromCodeCoverage]
public partial class Program;
