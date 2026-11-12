# Maestro smoke flow

`smoke.yaml` drives the release APK in demo mode (no backend, no sign-in): onboarding Skip → AR
(DEMO badge, aircraft count above zero) → List and the detail card → Map (opens on the Map with a Maps
key, on the Radar without one; both pass) → Settings. Selectors are RN `testID`s (Maestro `id:`).

## Run locally

Needs a running emulator or a device on `adb`, JDK 17, and the [Maestro CLI](https://docs.maestro.dev)
(CI pins the version in `.github/workflows/android-e2e.yml`).

```bash
cd app
npx expo prebuild -p android --no-install        # GOOGLE_MAPS_API_KEY in .env.local for the Map
cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=x86_64   # arm64-v8a for a phone
adb install -r app/build/outputs/apk/release/app-release.apk
cd .. && maestro test .maestro
```

The release build is signed with the Expo template's debug keystore and embeds the JS bundle, so
Metro is not needed. `launchApp` clears the app's state, so the flow starts from onboarding.

## CI

`.github/workflows/android-e2e.yml` runs the flow nightly, on manual dispatch, and on PRs labelled
`mobile-e2e`. On failure, Maestro's screenshots/debug output and logcat are uploaded as the
`maestro-output` artifact.
