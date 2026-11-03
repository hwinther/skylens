namespace Skylens.Api.Security;

/// <summary>
///     Security headers and the Content-Security-Policy on every response. CSP_MODE=report-only (the
///     default) sends the policy as Content-Security-Policy-Report-Only: browsers report violations to
///     <see cref="ReportPath" /> (<see cref="CspReports" />) and block nothing. CSP_MODE=enforce blocks.
///
///     The Expo web export has no inline scripts (index.html only references /_expo bundles), so
///     <c>script-src 'self'</c> holds without a nonce. Styles need <c>'unsafe-inline'</c>: the export
///     inlines its <c>expo-reset</c> &lt;style&gt;, and React Native Web and Leaflet inject styles at
///     runtime.
///
///     Deliberately different from the other apps:
///     <list type="bullet">
///         <item>Permissions-Policy allows camera, geolocation and the motion sensors for the page
///         itself: they ARE the web AR view.</item>
///         <item>No Cross-Origin-Opener-Policy: on web, expo-auth-session signs in through a popup whose
///         /oauth page posts the result back to <c>window.opener</c>. COOP same-origin would sever that
///         opener once the popup visits auth.wsh.no, and sign-in would hang.</item>
///         <item>/swagger stays unpoliced: Swashbuckle's UI page initialises with inline scripts.</item>
///     </list>
/// </summary>
internal static class SecurityHeaders
{
    /// <summary>Where browsers POST violation reports.</summary>
    public const string ReportPath = "/csp-report";

    /// <summary>The OIDC provider; the web app fetches its discovery document and tokens directly.</summary>
    private const string OidcAuthority = "https://auth.wsh.no";

    /// <summary>OpenStreetMap tiles for the Leaflet web map (components/webmap/LeafletMap.tsx).</summary>
    private const string MapTiles = "https://tile.openstreetmap.org";

    internal const string PermissionsPolicy =
        "camera=(self), geolocation=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self), "
        + "microphone=(), payment=(), usb=()";

    internal static readonly string ContentSecurityPolicy = string.Join("; ",
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        $"img-src 'self' data: blob: {MapTiles}",
        "font-src 'self' data:",
        // 'self' covers the SignalR hub's same-host wss:// connection.
        $"connect-src 'self' {OidcAuthority}",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        $"report-uri {ReportPath}",
        "report-to csp");

    /// <summary>Adds the headers to every response, ahead of static files, auth and endpoints.</summary>
    public static IApplicationBuilder UseSecurityHeaders(this IApplicationBuilder app, IConfiguration configuration)
    {
        var cspHeader = string.Equals(configuration["CSP_MODE"]?.Trim(), "enforce", StringComparison.Ordinal)
            ? "Content-Security-Policy"
            : "Content-Security-Policy-Report-Only";

        return app.Use((context, next) =>
        {
            var headers = context.Response.Headers;
            // Not includeSubDomains: that would force HTTPS on every *.wsh.no name.
            headers["Strict-Transport-Security"] = "max-age=31536000";
            headers["X-Content-Type-Options"] = "nosniff";
            headers["X-Frame-Options"] = "DENY";
            headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
            headers["Permissions-Policy"] = PermissionsPolicy;
            if (!context.Request.Path.StartsWithSegments("/swagger"))
            {
                headers[cspHeader] = ContentSecurityPolicy;
                headers["Reporting-Endpoints"] = $"csp=\"{ReportPath}\"";
            }
            return next(context);
        });
    }
}
