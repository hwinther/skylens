// Dynamic Expo config: keeps app.json as the source of truth and injects only the
// Google Maps Android API key at build time, so the raw key never lands in git.
//
// process.env.GOOGLE_MAPS_API_KEY is supplied by:
//   - local builds: app/.env.local (gitignored), auto-loaded by the Expo CLI
//   - EAS builds:   an EAS environment variable / secret of the same name
//
// Without it, prebuild omits the key and the Android Map tab (react-native-maps, Google
// provider) renders blank. Web is unaffected (map.web.tsx uses Leaflet/OSM).
module.exports = ({ config }) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    console.warn(
      '[app.config] GOOGLE_MAPS_API_KEY is not set — the Android Map tab will render blank. ' +
        'Set it in app/.env.local for local builds, or as an EAS env var for cloud builds.',
    );
    return config;
  }

  return {
    ...config,
    android: {
      ...config.android,
      config: {
        ...config.android?.config,
        googleMaps: { apiKey },
      },
    },
  };
};
