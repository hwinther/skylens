# Google / Play setup — deferred

Notes for shipping the Android app once the Google account is verified & active. Nothing here is
done yet; pick it up in order. Two separate "Google" concerns: a **Maps API key** (needed for the
Map tab on-device) and the **Play release path** (EAS Build → Play Console).

## 1. Google Maps API key — Map tab is blank on-device without it

`app/app/map.tsx` uses `react-native-maps`, which defaults to the Google provider on Android. There
is currently **no** `android.config.googleMaps.apiKey` in `app/app.json`, so a standalone build
renders a blank grey map. (Web is unaffected — `map.web.tsx` uses Leaflet/OSM.)

- [ ] Google Cloud project → enable **Maps SDK for Android**.
- [ ] Create an **API key**; restrict it: *Application restriction* = Android apps, package
      `no.wsh.skylens` + the app signing SHA-1(s). With EAS/Play App Signing there are two certs
      (upload key + Google's app-signing key) — add both. Get SHA-1 via `eas credentials`.
- [ ] Add to `app/app.json` under `android.config.googleMaps.apiKey`, sourced from an **env var /
      EAS secret** at build time — do NOT commit the raw key (repo rule: no secrets in git).
- [ ] Rebuild (`expo prebuild` regen) to pick it up.

## 2. Release path — EAS Build + Google Play

Today the app builds locally with `expo run:android`; there's no `eas.json` yet.

- [ ] **Google Play Developer account** (one-time $25). Create app entry `no.wsh.skylens`.
- [ ] Add `eas.json` with `preview` (internal APK) + `production` (AAB) profiles; let EAS manage
      signing / Play App Signing.
- [ ] `eas build -p android --profile production` → upload the first AAB **manually** to create the
      app + an **Internal testing** track.
- [ ] Automate with **EAS Submit**: create a **Google Cloud service account**, grant it release
      permission in Play Console, give EAS the JSON key → `eas submit` (or a CI step) pushes to the
      internal track.

## 3. Cross-cutting — required before a release goes live

- [ ] **Privacy policy** (hosted URL) + **Data safety** form. Mandatory because the app requests
      **camera + fine location**; the release is blocked without them.
- [ ] **Auth redirect**: the standalone build must keep the `skylens://` scheme working for the
      Authelia OIDC/PKCE round-trip. Ensure the Authelia client's allowed redirect URIs include the
      production redirect (may differ from the Expo-dev proxy URI used locally).

## What I (Claude) can scaffold in-repo when we resume

- `eas.json` with build + submit profiles.
- Wire `googleMaps.apiKey` to read from an EAS secret / env var (no raw key committed).

The Google Cloud project, Play developer account, and service-account JSON are console-only steps.
