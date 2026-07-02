using Microsoft.AspNetCore.Http.HttpResults;

namespace Skylens.Api.Endpoints;

/// <summary>
///     Anonymous <c>GET /</c>. Serves a tiny self-contained HTML landing/health page so browsing the
///     root URL does not hit the fallback authorization policy (401). Read-only: exposes nothing beyond
///     the service name and links to <c>/healthz</c> and <c>/swagger</c> — no data, secrets, or coordinates.
/// </summary>
public static class LandingEndpoints
{
    private const string LandingHtml =
        """
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Skylens</title>
          <style>
            body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
                   background: #0d1117; color: #c9d1d9; font-family: system-ui, sans-serif; }
            main { text-align: center; padding: 2rem; }
            h1 { margin: 0 0 .5rem; font-size: 2rem; color: #58a6ff; }
            p { margin: 0 0 1.5rem; color: #8b949e; }
            a { color: #58a6ff; text-decoration: none; margin: 0 .5rem; }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <main>
            <h1>Skylens</h1>
            <p>ADS-B plane-spotter gateway &mdash; API for the Skylens Android app</p>
            <nav><a href="/healthz">/healthz</a><a href="/swagger">/swagger</a></nav>
          </main>
        </body>
        </html>
        """;

    public static IEndpointRouteBuilder MapLandingEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/", ContentHttpResult () => TypedResults.Content(LandingHtml, "text/html; charset=utf-8"))
           .AllowAnonymous()
           .WithName("Landing");

        return app;
    }
}
