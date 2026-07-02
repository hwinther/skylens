using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using Skylens.Api.Options;

namespace Skylens.Api.Enrichment;

/// <summary>
///     OpenSky metadata fallback used only on an offline-DB miss. Authenticates with OAuth2
///     client-credentials (OpenSky retired basic auth), caches the token until shortly before expiry,
///     and looks up <c>/metadata/aircraft/icao/{hex}</c>. Results are cached 7 days by the caller.
/// </summary>
public sealed class OpenSkyMetadataClient
{
    private readonly HttpClient _http;
    private readonly OpenSkyOptions _options;
    private readonly TimeProvider _time;
    private readonly ILogger<OpenSkyMetadataClient> _logger;
    private readonly SemaphoreSlim _tokenGate = new(1, 1);

    private string? _token;
    private DateTimeOffset _tokenExpiry;

    public OpenSkyMetadataClient(
        HttpClient http,
        IOptions<OpenSkyOptions> options,
        TimeProvider time,
        ILogger<OpenSkyMetadataClient> logger)
    {
        _http = http;
        _options = options.Value;
        _time = time;
        _logger = logger;
    }

    public bool Configured => !string.IsNullOrEmpty(_options.ClientId) && !string.IsNullOrEmpty(_options.ClientSecret);

    public async Task<AircraftMetadata?> LookupAsync(string hex, CancellationToken ct)
    {
        if (!Configured)
            return null;

        try
        {
            var token = await GetTokenAsync(ct);
            if (token is null)
                return null;

            using var req = new HttpRequestMessage(HttpMethod.Get,
                $"{_options.MetadataBaseUrl}/metadata/aircraft/icao/{hex.ToLowerInvariant()}");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

            using var resp = await _http.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode)
                return null;

            var dto = await resp.Content.ReadFromJsonAsync<OpenSkyAircraftDto>(ct);
            if (dto is null)
                return null;

            return new AircraftMetadata
            {
                Hex = hex.ToLowerInvariant(),
                Registration = Blank(dto.Registration),
                TypeCode = Blank(dto.TypeCode),
                TypeName = Blank(dto.Model) ?? Blank(dto.Manufacturer),
                Operator = Blank(dto.Operator),
                Source = "opensky",
            };
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "OpenSky metadata lookup failed for {Hex}", hex);
            return null;
        }
    }

    private async Task<string?> GetTokenAsync(CancellationToken ct)
    {
        // Refresh a minute before expiry.
        if (_token is not null && _time.GetUtcNow() < _tokenExpiry - TimeSpan.FromMinutes(1))
            return _token;

        await _tokenGate.WaitAsync(ct);
        try
        {
            if (_token is not null && _time.GetUtcNow() < _tokenExpiry - TimeSpan.FromMinutes(1))
                return _token;

            using var req = new HttpRequestMessage(HttpMethod.Post, _options.TokenEndpoint)
            {
                Content = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["grant_type"] = "client_credentials",
                    ["client_id"] = _options.ClientId!,
                    ["client_secret"] = _options.ClientSecret!,
                }),
            };

            using var resp = await _http.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("OpenSky token endpoint returned {Status}", resp.StatusCode);
                return null;
            }

            var token = await resp.Content.ReadFromJsonAsync<OAuthTokenDto>(ct);
            if (token?.AccessToken is null)
                return null;

            _token = token.AccessToken;
            _tokenExpiry = _time.GetUtcNow().AddSeconds(token.ExpiresIn > 0 ? token.ExpiresIn : 1800);
            return _token;
        }
        finally
        {
            _tokenGate.Release();
        }
    }

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    private sealed record OAuthTokenDto(
        [property: JsonPropertyName("access_token")] string? AccessToken,
        [property: JsonPropertyName("expires_in")] int ExpiresIn);

    private sealed record OpenSkyAircraftDto(
        [property: JsonPropertyName("registration")] string? Registration,
        [property: JsonPropertyName("typecode")] string? TypeCode,
        [property: JsonPropertyName("model")] string? Model,
        [property: JsonPropertyName("manufacturerName")] string? Manufacturer,
        [property: JsonPropertyName("operator")] string? Operator);
}
