namespace Skylens.Api.State;

/// <summary>Small geo helpers shared by radius filtering and grid-cell bucketing.</summary>
public static class Geo
{
    private const double EarthRadiusKm = 6371.0088;

    /// <summary>Great-circle distance between two lat/lon points, in kilometres.</summary>
    public static double DistanceKm(double lat1, double lon1, double lat2, double lon2)
    {
        var dLat = ToRad(lat2 - lat1);
        var dLon = ToRad(lon2 - lon1);
        var a = Math.Sin(dLat / 2) * Math.Sin(dLat / 2) +
                Math.Cos(ToRad(lat1)) * Math.Cos(ToRad(lat2)) *
                Math.Sin(dLon / 2) * Math.Sin(dLon / 2);
        return 2 * EarthRadiusKm * Math.Asin(Math.Min(1, Math.Sqrt(a)));
    }

    private static double ToRad(double deg) => deg * Math.PI / 180.0;
}
