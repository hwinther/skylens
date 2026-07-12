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

    /// <summary>AIS-catcher vessel feed topic, subscribed on the same connection. Empty = AIS ingest off.</summary>
    public string AisTopic { get; set; } = "ais/data";

    /// <summary>
    ///     Dev/E2E only: swap the real broker for a transport that replays <see cref="ReplayFile" />
    ///     through the normal ingest pipeline at 1 Hz. Honored only in Development (see Program.cs).
    ///     <see cref="Host" /> must still be non-empty for the ingest loop to run.
    /// </summary>
    public bool Replay { get; set; }

    /// <summary>Path to a dump1090 <c>aircraft.json</c> replayed when <see cref="Replay" /> is true.</summary>
    public string ReplayFile { get; set; } = string.Empty;

    /// <summary>Dev/E2E only: replay a captured AIS stream alongside <see cref="Replay" />. Wired in a later phase.</summary>
    public bool AisReplay { get; set; }

    /// <summary>Path to a captured <c>ais/data</c> capture replayed when <see cref="AisReplay" /> is true.</summary>
    public string? AisReplayFile { get; set; }
}

/// <summary>
///     Browser CORS. Empty in production — the mobile app is not a browser and needs no CORS. Set to
///     the web dev origin(s), comma-separated, so the react-native-web build / Playwright E2E can call
///     the API and SignalR hub cross-origin.
/// </summary>
public sealed class CorsOptions
{
    public const string SectionName = "Cors";

    /// <summary>Comma-separated allowed origins, e.g. "http://localhost:8081".</summary>
    public string Origins { get; set; } = string.Empty;

    /// <summary>Split + trimmed origins; empty array means CORS stays off.</summary>
    public string[] ParsedOrigins() =>
        Origins.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
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

/// <summary>
///     "Satellites in line-of-sight": TLE orbital elements from CelesTrak (OMM/GP JSON) plus
///     transmitter frequencies from the SatNOGS DB. Both are free, key-less public APIs, so the only
///     protection is a daily call budget that fails closed. <see cref="Groups" /> is the comma-separated
///     list of CelesTrak GP groups to pull; only these seven names actually exist upstream
///     (noaa / glonass-operational do NOT — they 200 with a plain-text error body). CelesTrak also
///     flipped its default response format to CSV in 2026, so every request appends <c>FORMAT=JSON</c>.
///     <see cref="TleFile" />/<see cref="TransmittersFile" /> are Development-only fixtures that replace
///     the network entirely (ignored with a warning outside Development).
/// </summary>
public sealed class SatellitesOptions
{
    public const string SectionName = "Satellites";

    /// <summary>Comma-separated CelesTrak GP group names. Only these seven exist upstream.</summary>
    public string Groups { get; set; } = "amateur,stations,weather,gps-ops,galileo,glo-ops,beidou";

    /// <summary>CelesTrak GP endpoint; the group + <c>FORMAT=JSON</c> are appended per request.</summary>
    public string CelestrakBaseUrl { get; set; } = "https://celestrak.org/NORAD/elements/gp.php";

    /// <summary>One budget unit per group request; fails closed for the rest of the UTC day.</summary>
    public int CelestrakDailyBudget { get; set; } = 120;

    /// <summary>SatNOGS DB base; the bulk <c>/api/transmitters/</c> pull lives here.</summary>
    public string SatNogsBaseUrl { get; set; } = "https://db.satnogs.org";

    /// <summary>One budget unit per transmitters page request (the bulk pull is a single page).</summary>
    public int SatNogsDailyBudget { get; set; } = 60;

    /// <summary>Dev-only: load OMM records from this file instead of CelesTrak (never network).</summary>
    public string? TleFile { get; set; }

    /// <summary>Dev-only: load SatNOGS transmitters from this file instead of the API (never network).</summary>
    public string? TransmittersFile { get; set; }

    /// <summary>Split + trimmed CelesTrak group names.</summary>
    public string[] ParsedGroups() =>
        Groups.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}

/// <summary>
///     BarentsWatch Live AIS — official Norwegian AIS (NLOD-licensed, free). OAuth2 client-credentials
///     (scope "ais") against <see cref="TokenEndpoint" />; a daily <see cref="DailyBudget" /> fails closed.
///     Supplies away-mode vessel coverage in Norwegian waters and static/voyage enrichment for
///     <c>/api/vessels/{mmsi}</c>. Excludes fishing &lt;15 m and leisure &lt;45 m by license. Credentials
///     come from env/secrets (<c>BARENTSWATCH__CLIENTID</c> / <c>BARENTSWATCH__CLIENTSECRET</c>), never
///     committed. <see cref="Configured" /> gates every upstream call.
/// </summary>
public sealed class BarentsWatchOptions
{
    public const string SectionName = "BarentsWatch";

    public string? ClientId { get; set; }
    public string? ClientSecret { get; set; }

    /// <summary>OAuth2 token endpoint (client-credentials grant, scope "ais").</summary>
    public string TokenEndpoint { get; set; } = "https://id.barentswatch.no/connect/token";

    /// <summary>Live AIS API base (latest/combined snapshot + per-MMSI filter live here).</summary>
    public string BaseUrl { get; set; } = "https://live.ais.barentswatch.no";

    public int DailyBudget { get; set; } = 2000;

    public bool Configured => !string.IsNullOrEmpty(ClientId) && !string.IsNullOrEmpty(ClientSecret);
}
