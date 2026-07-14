using System.Text.Json.Nodes;
using Microsoft.OpenApi;
using Skylens.Api.Options;

namespace Skylens.Api.Extensions;

/// <summary>
///     OpenAPI wiring. The Swashbuckle document ("v1") is the source of truth the app's TypeScript
///     client is generated from: the <c>CreateSwaggerJson</c> MSBuild target runs
///     <c>dotnet swagger tofile</c> on every Debug build to emit <c>openapi.json</c>, and the app's
///     <c>npm run openapi:generate</c> turns that into typed contracts. Schema ids use the full .NET
///     type name so the generated names are stable and unambiguous.
///
///     "Authorize" in Swagger UI runs a REAL Authelia login (authorization-code + PKCE, public client)
///     so the auth-gated endpoints are callable straight from the docs. The OAuth endpoints are built
///     from the bound <see cref="OidcOptions" /> — with a fallback to the appsettings default when the
///     authority is unset — so the emitted <c>openapi.json</c> stays byte-stable across builds.
/// </summary>
internal static class OpenApiExtensions
{
    /// <summary>Security-scheme id referenced by the global requirement and the Swagger UI OAuth wiring.</summary>
    private const string OidcSchemeId = "oidc";

    /// <summary>
    ///     Scopes the docs request, mirroring the app's OIDC login (see <c>app/src/auth/config.ts</c>). The
    ///     access token's <c>aud=skylens-api</c> does NOT come from a scope — it comes from the audience
    ///     request parameter wired into Swagger UI below, exactly the way the app requests it.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> OAuthScopes = new Dictionary<string, string>
    {
        ["openid"] = "OpenID Connect sign-in (required)",
        ["profile"] = "Basic profile claims",
        ["email"] = "Email address",
        ["groups"] = "Group membership (backend authorization)",
        ["offline_access"] = "Refresh token",
    };

    public static IServiceCollection AddOpenApiDocumentation(this IServiceCollection services, OidcOptions oidc)
    {
        var authority = ResolveAuthority(oidc);

        services.AddEndpointsApiExplorer();
        services.AddOpenApi();
        services.AddSwaggerGen(options =>
        {
            options.CustomSchemaIds(static type => type.FullName?.Replace("+", ".") ?? type.Name);

            // GeoJSON `geometry` on the fishing-mode DTOs is a JsonNode passed through VERBATIM. Left to
            // its own devices Swashbuckle introspects JsonNode's CLR internals (recursive parent/root
            // refs, additionalProperties:false), producing a misleading schema that also mismatches the
            // real geometry at runtime. Map it to a free-form object so it types as a loose object the
            // client casts to a GeoJSON geometry (Polygon/MultiPolygon/LineString/Point).
            options.MapType<JsonNode>(static () => new OpenApiSchema { Type = JsonSchemaType.Object });
            options.SwaggerDoc("v1", new OpenApiInfo
            {
                Version = "v1",
                Title = "Skylens API",
                Description = ApiBuildMetadata.BuildOpenApiDescription(
                    "ADS-B plane-spotter gateway — API for the Skylens app."),
            });

            // Authelia OIDC (authorization-code + PKCE). The URLs are built from the bound authority so
            // the doc is deterministic; the aud=skylens-api mechanism is the runtime audience param below.
            options.AddSecurityDefinition(OidcSchemeId, new OpenApiSecurityScheme
            {
                Type = SecuritySchemeType.OAuth2,
                Description = "Authelia OIDC — authorization-code flow with PKCE (public client, no secret).",
                Flows = new OpenApiOAuthFlows
                {
                    AuthorizationCode = new OpenApiOAuthFlow
                    {
                        AuthorizationUrl = new Uri($"{authority}/api/oidc/authorization"),
                        TokenUrl = new Uri($"{authority}/api/oidc/token"),
                        Scopes = new Dictionary<string, string>(OAuthScopes),
                    },
                },
            });
            // Microsoft.OpenApi v2 resolves a scheme reference against the host document, so the
            // requirement is built per-document via the callback (the reference carries `doc`).
            options.AddSecurityRequirement(doc => new OpenApiSecurityRequirement
            {
                [new OpenApiSecuritySchemeReference(OidcSchemeId, doc, null)] = OAuthScopes.Keys.ToList(),
            });
        });

        return services;
    }

    public static WebApplication UseOpenApiDocumentation(this WebApplication app, OidcOptions oidc)
    {
        app.MapOpenApi().AllowAnonymous();
        app.UseSwagger();
        app.UseSwaggerUI(options =>
        {
            // Real Authelia login from the docs: a dedicated public swagger client + PKCE, no secret.
            options.OAuthClientId(oidc.SwaggerClientId);
            options.OAuthScopes(OAuthScopes.Keys.ToArray());
            options.OAuthUsePkce();
            // Mirror the app (app/src/auth/useAuth.ts extraParams.audience): request the API audience so
            // Authelia stamps aud=skylens-api on the access token the backend's JwtBearer validates.
            options.OAuthAdditionalQueryStringParams(new Dictionary<string, string>
            {
                ["audience"] = ResolveAudience(oidc),
            });
        });

        return app;
    }

    /// <summary>
    ///     OAuth-endpoint authority; falls back to the <see cref="OidcOptions" /> default when unset so the
    ///     <c>dotnet swagger tofile</c> output can't flap on a local config that leaves the authority blank.
    /// </summary>
    private static string ResolveAuthority(OidcOptions oidc) =>
        (string.IsNullOrWhiteSpace(oidc.Authority) ? new OidcOptions().Authority : oidc.Authority).TrimEnd('/');

    /// <summary>API audience requested at login; falls back to the default like <see cref="ResolveAuthority" />.</summary>
    private static string ResolveAudience(OidcOptions oidc) =>
        string.IsNullOrWhiteSpace(oidc.Audience) ? new OidcOptions().Audience : oidc.Audience;
}
