using Microsoft.AspNetCore.StaticFiles;

namespace Skylens.Api.Extensions;

/// <summary>
///     Content types for the exported web app in wwwroot: ASP.NET's defaults plus the few the app ships
///     that the default table lacks. The static-file middleware skips a file whose extension it cannot
///     map, so without an entry the request would fall through to the 404 guard / auth instead.
///     <c>.glb</c>: the cockpit view's baked 3D models (<c>app/public/models/sim/*.glb</c>).
/// </summary>
internal static class StaticContentTypes
{
    public static FileExtensionContentTypeProvider Create()
    {
        var provider = new FileExtensionContentTypeProvider();
        provider.Mappings[".glb"] = "model/gltf-binary";
        return provider;
    }
}
