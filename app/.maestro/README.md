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
aircraft's position with the HUD top left and Exit / Map top right; "Map imagery unavailable
(<reason>)" under the HUD means the globe runs without a map. Screenshots are `optional` too
(UiAutomation can return none on a starved emulator). The flow then logs the globe's own account to
`maestro.log`: `SkylensSim globe = <its accessibility label>` and, in the CI build
(`EXPO_PUBLIC_SIM_DIAG=1`), `SkylensSim diag = gl=…|tex=…|wk=…|img=req/ok/fail|ter=req/ok/fail|q=…|fr=…|ff=…|px=r,g,b|blk=…|err=…|last=…`
(keys in `src/sim/globeDiag.ts`). It is its own file so a globe problem fails as its own flow and
never makes the smoke steps flaky. Before leaving it checks the card, the Layers filter and that the
`sim-camera-toggle` is there, but never switches the outside view on: on the software-GL CI emulator
that hung the emulator's GPU (ANRs, app killed); Playwright and jest cover the toggle.

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
`mobile-e2e`. The build restores a Gradle cache and a ccache of the NDK C++ compile (both written only
by runs on main; PR runs just read them), and logs `ccache --show-stats` after the Gradle step. Every
run (pass or fail) uploads a `maestro-output-<attempt>` artifact, kept 7 days: the flows' screenshots (`artifacts/<timestamp>/<flow name>/screenshots`, e.g. `Smoke (demo mode)` and
`Cockpit view (demo mode)`), the JUnit report,
Maestro's log and the failing step's view hierarchy, plus device screenshots from just before and
after the test, logcat (main, system, crash, events; from boot), `dumpsys activity activities`, the
dropbox ANR/crash entries, and `sim-diag.txt`: every `SkylensSim` line (native screen, the globe
webview's console as `chromium` `[INFO:CONSOLE…]`, and the flow's own) from the per-flow device logcat
and `maestro.log`; its tail is also printed in the job log.

## System dialogs

On a freshly booted CI emulator another app can go ANR ("Pixel Launcher isn't responding") and its
dialog hides the app from Maestro. CI sets `hide_error_dialogs` so such an app is killed instead of
showing the dialog, and the flow's long waits are `retry` blocks that first run
`subflows/dismiss-system-anr.yaml`, which taps "Close app" on another app's ANR dialog. Our own
app's dialog ("Skylens isn't responding") is never dismissed, so an ANR in the app still fails the
flow. Sub-flows live in `subflows/` because `maestro test .maestro` runs every top-level YAML file.
