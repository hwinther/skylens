// Dynamic Expo config: keeps app.json as the source of truth and injects a couple of build-time
// values so nothing secret or environment-specific lands in git:
//   - Google Maps Android API key (GOOGLE_MAPS_API_KEY) -> native manifest.
//   - Android versionCode (ANDROID_VERSION_CODE) -> set by CI so each Play upload is unique.
//
// GOOGLE_MAPS_API_KEY is supplied by:
//   - local builds: app/.env.local (gitignored), auto-loaded by the Expo CLI
//   - EAS builds:   an EAS environment variable / secret of the same name
//   - CI builds:    a GitHub Actions secret exported into the prebuild step's env
//
// Without the key, prebuild omits it and the Android Map tab (react-native-maps, Google provider)
// renders blank/crashes. Web is unaffected (map.web.tsx uses Leaflet/OSM).
module.exports = ({ config }) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const versionCode = process.env.ANDROID_VERSION_CODE;

  const android = { ...config.android };

  if (apiKey) {
    android.config = { ...android.config, googleMaps: { apiKey } };
  } else {
    console.warn(
      '[app.config] GOOGLE_MAPS_API_KEY is not set — the Android Map tab will render blank. ' +
        'Set it in app/.env.local for local builds, or as an EAS/CI env var for cloud builds.',
    );
  }

  // CI (GitHub Actions) sets a monotonic versionCode from the run number so each Play upload is
  // unique. Absent locally / on EAS (which manages versionCode remotely), this is skipped and
  // Expo's default applies.
  if (versionCode) android.versionCode = Number(versionCode);

  return { ...config, android };
};
