namespace Skylens.Api.Options;

/// <summary>OIDC / JwtBearer settings. Authority + Audience validate RFC 9068 access tokens.</summary>
public sealed class OidcOptions
{
    public const string SectionName = "Oidc";

    public string Authority { get; set; } = "https://auth.wsh.no";
    public string Audience { get; set; } = "skylens-api";

    /// <summary>Swagger UI OAuth client id (dev only).</summary>
    public string ClientId { get; set; } = "skylens";
}

/// <summary>
///     Dev-only escape hatch. When <see cref="Disabled" /> is true AND the environment is Development,
///     JwtBearer is replaced with a test-auth handler that stamps a fixed principal on every request.
///     Never honored outside Development.
/// </summary>
public sealed class AuthOptions
{
    public const string SectionName = "Auth";

    public bool Disabled { get; set; }
}

/// <summary>MQTT broker connection. Host empty = ingest disabled (healthz reports disconnected).</summary>
public sealed class MqttOptions
{
    public const string SectionName = "Mqtt";

    public string Host { get; set; } = string.Empty;
    public int Port { get; set; } = 1883;
    public string Topic { get; set; } = "adsb/aircraft";
    public string? Username { get; set; }
    public string? Password { get; set; }
}

/// <summary>Home feed location + coverage radius. Coords are secret by repo convention.</summary>
public sealed class FeedOptions
{
    public const string SectionName = "Feed";

    public double Lat { get; set; }
    public double Lon { get; set; }

    /// <summary>Subscribers farther than this from the feed are served away-mode (ADSBx) data.</summary>
    public double RadiusKm { get; set; } = 300;
}

/// <summary>OpenSky OAuth2 client-credentials (metadata fallback on DB miss).</summary>
public sealed class OpenSkyOptions
{
    public const string SectionName = "OpenSky";

    public string? ClientId { get; set; }
    public string? ClientSecret { get; set; }

    /// <summary>OAuth2 token endpoint (client-credentials grant).</summary>
    public string TokenEndpoint { get; set; } =
        "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

    public string MetadataBaseUrl { get; set; } = "https://opensky-network.org/api";
}

/// <summary>ADSBx via RapidAPI point-radius. MonthlyBudget fails closed when exhausted.</summary>
public sealed class AdsbxOptions
{
    public const string SectionName = "Adsbx";

    public string? RapidApiKey { get; set; }
    public string RapidApiHost { get; set; } = "adsbexchange-com1.p.rapidapi.com";
    public int MonthlyBudget { get; set; } = 1000;
}

/// <summary>FlightAware AeroAPI route lookups by callsign. DailyBudget fails closed.</summary>
public sealed class AeroApiOptions
{
    public const string SectionName = "AeroApi";

    public string? ApiKey { get; set; }
    public string BaseUrl { get; set; } = "https://aeroapi.flightaware.com/aeroapi";
    public int DailyBudget { get; set; } = 100;
}

/// <summary>Bundled offline aircraft type/registration DB (tar1090-db aircraft.csv.gz).</summary>
public sealed class AircraftDbOptions
{
    public const string SectionName = "AircraftDb";

    public string Path { get; set; } = "/app/data/aircraft.csv.gz";
}
