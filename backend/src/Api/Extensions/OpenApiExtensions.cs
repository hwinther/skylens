using System.Text.Json.Nodes;
using Microsoft.OpenApi;

namespace Skylens.Api.Extensions;

/// <summary>
///     OpenAPI wiring. The Swashbuckle document ("v1") is the source of truth the app's TypeScript
///     client is generated from: the <c>CreateSwaggerJson</c> MSBuild target runs
///     <c>dotnet swagger tofile</c> on every Debug build to emit <c>openapi.json</c>, and the app's
///     <c>npm run openapi:generate</c> turns that into typed contracts. Schema ids use the full .NET
///     type name so the generated names are stable and unambiguous.
/// </summary>
internal static class OpenApiExtensions
{
    public static IServiceCollection AddOpenApiDocumentation(this IServiceCollection services)
    {
        services.AddEndpointsApiExplorer();
        services.AddOpenApi();
        services.AddSwaggerGen(static options =>
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
        });

        return services;
    }

    public static WebApplication UseOpenApiDocumentation(this WebApplication app)
    {
        app.MapOpenApi().AllowAnonymous();
        app.UseSwagger();
        app.UseSwaggerUI();

        return app;
    }
}
