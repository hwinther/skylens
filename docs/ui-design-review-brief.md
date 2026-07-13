# Skylens — UI/UX design review brief

A brief for a design-focused review of the Skylens app. Read this, then read the files it points to
(you have repo access). Goal: **prioritized, Skylens-specific UI/UX improvements**, not generic advice.

## What Skylens is

An Android-first (Expo / React Native; also a web build) **augmented-reality spotter**. Point the phone
at the sky/horizon and see labeled objects overlaid on the live camera, placed by GPS + compass/gyro
sensor fusion (pinhole projection — no ARCore). It now tracks **four entity families**:

- **Aircraft** (ADS-B),
- **Ships + aids-to-navigation** (AIS),
- **Satellite passes** (SGP4, with Doppler/transmitter data + ground tracks),
- **Solar-system bodies** — sun, moon, planets (on-device astronomy, no network).

Beyond the AR view there's a **Radar** plan-view (with zoom/range control), a real **Map**, a
nearest-first **List** (Traffic / Overhead / Sky sections), a **Settings** screen, and **four** slide-up
**detail sheets** (aircraft, vessel, satellite, planet). The maps also carry **fishing overlays**
(forbidden/restricted zones, cod boundaries, lost-gear markers) and **course vectors** (velocity leaders).

**Context of use:** outdoors, one-handed, often in bright daylight, glancing between the screen and the
actual sky/sea. Legibility, glanceability, and trust indicators matter more than decoration.

## Platform & constraints (please respect)

- Expo / React Native; **Android primary**, web via react-native-web; **dark theme only**.
- **Performance is load-bearing.** The AR overlay runs a single ~20 fps `requestAnimationFrame` loop
  (`MIN_INTERVAL_MS = 1000/20`) that reprojects N entities, runs **per-type declutter passes**, and
  re-renders labels; the 60 fps pose reads from refs, not zustand. There's a history of JS-thread
  freezes here — do **not** propose per-frame heavy work, blur, or animations that would repin the
  thread. (`ArOverlay.tsx` documents the cap and why.)
- **RN/Expo components only** — avoid heavy native deps (custom steppers are used deliberately instead
  of a native slider).

## Current design language (keep the spirit, sharpen the execution)

A coherent **dark HUD / tactical-instrument** aesthetic: deep navy `#0B1622` ground, cyan `#78C8FF`
primary accent, translucent chips with hairline borders, ticks + leader lines, range rings, cardinal
(N/E/S/W) compass hints, status dots, and DEMO/LIVE badges.

**Entity type is encoded by an accent family** — this semantic separation is a strength; keep it, but
note it now spans **four hue families plus AtoN/fishing colors**, which is a lot of hue to carry:

| Entity | Accent | Icon family (MaterialCommunityIcons) |
|---|---|---|
| Aircraft | blue `#78C8FF` | by ADS-B category (`airplane`, `helicopter`, …) |
| Vessel (ship) | teal `#3FC9B0` + class variants (see below) | `ferry` / `fish` / `ship-wheel` / `sail-boat` |
| Aid-to-navigation | amber `#F2C14E` (physical) · muted magenta `#C77DBB` (virtual) | `lighthouse` / `lifebuoy` / `map-marker-radius-outline` |
| Satellite | violet `#C792EA` | `satellite-variant` |
| Planet / sun / moon | gold `#FFCF5C` | `white-balance-sunny` / `moon-full` / `circle` |

Vessel class palette (`vesselIcon.ts`): ship `#3FC9B0`, cargo `#4FB477`, tanker `#E0725C`, high-speed
`#48B7D8`, fishing `#5EC26A`, special/tug `#E0A94E`, sailing `#7FD1E8`, AtoN `#F2C14E`, virtual-AtoN
`#C77DBB`. Fishing overlays: forbidden `#E4483B`, restricted `#F0A63C`, cod boundary `#E85CC0`,
lost-gear `#FF8A3D` (`hook`). Course vectors: aircraft `#78C8FF`, ship `#3FC9B0`. Status signal colors:
ok `#7CFC9A`, warn `#FFD37C`, error `#FF8A80`. Tabs use Ionicons; system font throughout.

## Surfaces to review (files)

- **AR overlay (the hero):** `app/app/index.tsx`, `app/src/components/ArOverlay.tsx`, and the label
  components `AircraftLabel.tsx`, `VesselLabel.tsx`, `SatelliteLabel.tsx`, `PlanetLabel.tsx`, plus
  `StatusStrip.tsx`, `CompassCalibration.tsx`. (The overlay also draws a faint ecliptic arc.)
- **Map / radar:** `app/app/map.tsx` (a thin re-export) → **`app/src/screens/MapScreen.tsx`** (native) and
  **`app/src/screens/MapScreen.web.tsx`** (web); `MapViewToggle.tsx`, `AircraftRadar.tsx` (now with a
  zoom/range ladder), `src/components/webmap/LeafletMap.tsx`, `webmap/course.ts` (velocity leaders),
  `webmap/fishingStyle.ts` (zone/marker styling).
- **List:** `app/app/list.tsx` — three sections: **Traffic** (aircraft + vessels), **Overhead**
  (satellites), **Sky** (planets), all tappable to their sheets.
- **Settings:** `app/app/settings.tsx` (now **8 grouped sections**) + `src/state/settingsStore.ts`.
  **Sign-in:** `app/app/sign-in.tsx`; hidden `oauth` route `app/app/oauth.tsx`.
- **Detail sheets (4):** `DetailSheet.tsx` (aircraft), `VesselDetailSheet.tsx`, `SatelliteDetailSheet.tsx`
  (live pass + AOS/LOS + Doppler downlinks + SatNOGS transmitters + ground-track button),
  `PlanetDetailSheet.tsx` (on-device rise/set/culmination).
- **Overlay data hooks / stores:** `usePlanets.ts`, `useFishingLayers.ts`, `useSatelliteGroundTrack.ts`,
  `state/satelliteTrackStore.ts`.
- **Entity color/icon logic:** `src/components/aircraftIcon.ts`, `src/components/vesselIcon.ts` (plus the
  scattered `SAT_VIOLET`, `PLANET_GOLD`, `VESSEL_TEAL` constants — see rough edge #1).

## Known rough edges (validate, prioritize, and add your own)

1. **No design-token system — now the single highest-leverage cleanup.** Every color/size is a hardcoded
   literal per file, and duplication has grown: `SAT_VIOLET = #C792EA` is copy-pasted in **6 files**,
   `PLANET_GOLD = #FFCF5C` in 3, `VESSEL_TEAL = #3FC9B0` in several, plus the fishing and course palettes.
   There is still **no** central theme/tokens/colors module. This blocks consistent theming and any
   colorblind-safe rework.
2. **Marker color inconsistency.** Aircraft are blue everywhere **except the native map**, where
   `MapScreen.tsx`'s `AircraftMarker` is amber `#FFB450`. The same blue appears as both `#78C8FF` and
   `rgba(120,200,255,…)`; error red as both `#FF8A80` and `#ff8a80`.
3. **Hue overload + colorblind risk (worse than before).** Entity identity now leans on **four accent
   hues** (blue/teal/violet/gold), *plus* amber/magenta for physical/virtual AtoN, *plus* fishing
   red/orange/magenta, *plus* status green/amber/red. And passenger/cargo/tanker/high-speed ships still
   share the **`ferry`** glyph, separated **only by color**. This needs shape + color redundancy, not
   more hues.
4. **Cross-type label density / decluttering.** The AR HUD can now show aircraft + ships + AtoN +
   satellites + planets + ecliptic **at once** (each its own declutter pass), and the maps add fishing
   zones + course vectors + ground tracks. Prioritizing and thinning across many entity types — and
   giving the user control — is a real design problem, not just per-type spacing.
5. **Missing empty / first-run states.** List renders "Traffic (0) / Overhead (0) / Sky (0)"; the AR
   overlay and Radar show nothing when there's no data — no "waiting for GPS fix / no traffic in range"
   guidance.
6. **No onboarding or permission priming.** Camera denial degrades silently to a synthetic horizon, and
   the many new toggles (ships, AtoN, satellites, planets, ecliptic, fishing zones, lost gear, course
   vectors) have no discovery or explanation of demo vs live or the trust indicators (GPS `±N m`,
   Compass Unreliable→High).
7. **Ad-hoc spacing/radii** (4/6/8/10/12/18, varied paddings) — no scale.
8. **Steppers for wide continuous ranges** (radius 10–400 in steps of 10; elevation mask 0–15) are slow
   to operate — the Radar gained a zoom/range ladder, but Settings still uses steppers throughout.

> Note: the previous brief's "vessels are non-interactive" edge is **mostly fixed** — vessels are now
> tappable in the List, Radar, and both Maps via `VesselDetailSheet`. Only the AR surface-band
> `VesselLabel` stays deliberately non-interactive (`pointerEvents: none`) because the horizon strip is
> too dense to tap reliably — worth a design opinion, but it's intentional.

## What I want from you

Prioritized, **Skylens-specific** recommendations — ideally with quick mockups/specs and an effort-vs-impact
call on each:

1. **AR HUD legibility + declutter in daylight, across four entity families at once** — label density,
   contrast, cross-type prioritization, and the status strip. This is the product; it must read at arm's
   length in sun without becoming a wall of chips.
2. **A concrete design-token proposal** (colors / spacing / type scale / radii) that captures the current
   look, kills the 6-file color duplication, and is **colorblind-safer** — shape + color redundancy so the
   four entity families (and the AtoN/fishing sub-colors) don't rely on hue alone.
3. **Empty / loading / first-run / permission states**, plus light onboarding that surfaces the many
   toggles and explains demo vs live and what the trust indicators mean.
4. **Consistency + affordance fixes** — the amber vs blue map marker, the `ferry`-glyph-by-color ships,
   tap-target sizes, and the AR vessel-label non-interactivity.
5. **Information architecture** for the List (Traffic / Overhead / Sky) and the growing Settings (8
   sections) as the entity count keeps rising.
6. Anything that makes it feel **more polished/premium** while staying true to the HUD aesthetic and the
   performance constraints above.

Keep the tactical-HUD identity and the entity color semantics; refine rather than reskin.
