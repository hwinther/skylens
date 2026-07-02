using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Skylens.Api.Auth;

/// <summary>
///     Dev-only test-auth handler. Stamps a fixed authenticated principal on every request so the API
///     is usable without an OIDC round-trip during local development. Wired in <c>Program.cs</c> ONLY
///     when <c>Environment.IsDevelopment()</c> AND <c>Auth:Disabled=true</c> — never outside Development.
/// </summary>
public sealed class DevAuthHandler : AuthenticationHandler<AuthenticationSchemeOptions>
{
    public const string SchemeName = "DevAuth";

    public DevAuthHandler(
        IOptionsMonitor<AuthenticationSchemeOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder)
        : base(options, logger, encoder)
    {
    }

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var claims = new[]
        {
            new Claim("sub", "dev-user"),
            new Claim("preferred_username", "dev"),
            new Claim("name", "Dev User"),
            new Claim("groups", "skylens-users"),
        };

        var identity = new ClaimsIdentity(claims, SchemeName);
        var principal = new ClaimsPrincipal(identity);
        var ticket = new AuthenticationTicket(principal, SchemeName);
        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}
