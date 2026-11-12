# Maestro smoke flow

`smoke.yaml` drives the release APK in demo mode (no backend, no sign-in): onboarding Skip → AR
(DEMO badge, aircraft count above zero) → List and the detail card → Map (opens on the Map with a Maps
key, on the Radar without one; both pass) → Settings. Selectors are RN `testID`s (Maestro `id:`).

`cockpit.yaml` opens the cockpit view (simulator) for the first aircraft in the List (detail card →
"Cockpit view"), waits for the 3D globe, screenshots it and leaves with the hardware back button. The
globe is Cesium in a webview (an Expo DOM component) with network imagery and, on an emulator,
software WebGL, so only the native screen is asserted (it opens with its HUD and Exit, and back leaves
it): whether the globe got to `sim-globe-ready` (first frame rendered), `sim-globe-failed` (no WebGL,
engine didn't load, 60 s timeout; the card says why) or is still `sim-globe-loading` is left to the
`cockpit` screenshot (those waits are `optional`). Expected there: the satellite-imagery globe from the
aircraft's position with the HUD top left and Exit / Map top right. It is its own file so a globe
problem fails as its own flow and never makes the smoke steps flaky.

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
`mobile-e2e`. Every run (pass or fail) uploads a `maestro-output-<attempt>` artifact, kept 7 days:
the flows' screenshots (`artifacts/<timestamp>/<flow name>/screenshots`, e.g. `Smoke (demo mode)` and
`Cockpit view (demo mode)`), the JUnit report,
Maestro's log and the failing step's view hierarchy, plus device screenshots from just before and
after the test, logcat (main, system, crash, events; from boot), `dumpsys activity activities`, and
the dropbox ANR/crash entries.

## System dialogs

On a freshly booted CI emulator another app can go ANR ("Pixel Launcher isn't responding") and its
dialog hides the app from Maestro. CI sets `hide_error_dialogs` so such an app is killed instead of
showing the dialog, and the flow's long waits are `retry` blocks that first run
`subflows/dismiss-system-anr.yaml`, which taps "Close app" on another app's ANR dialog. Our own
app's dialog ("Skylens isn't responding") is never dismissed, so an ANR in the app still fails the
flow. Sub-flows live in `subflows/` because `maestro test .maestro` runs every top-level YAML file.
