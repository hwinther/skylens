# Skylens — UI/UX design review brief

A brief for a design-focused review of the Skylens app. Read this, then read the files it points to
(you have repo access). Goal: **prioritized, Skylens-specific UI/UX improvements**, not generic advice.

## What Skylens is

An Android-first (Expo / React Native; also a web build) **augmented-reality spotter**. Point the phone
at the sky/horizon and see labeled **aircraft** (ADS-B), **ships + aids-to-navigation** (AIS), and
**satellite passes** (SGP4) overlaid on the live camera, placed by GPS + compass/gyro sensor fusion
(pinhole projection — no ARCore). Beyond the AR view there's a **radar** plan-view, a real **map**, a
nearest-first **list**, a **settings** screen, and slide-up **detail sheets**.

**Context of use:** outdoors, one-handed, often in bright daylight, glancing between the screen and the
actual sky. Legibility, glanceability, and trust indicators matter more than decoration.

## Platform & constraints (please respect)

- Expo / React Native; **Android primary**, web via react-native-web; **dark theme only**.
- **Performance is load-bearing.** The AR overlay runs a ~20 fps `requestAnimationFrame` loop that
  reprojects N entities, runs per-type declutter passes, and re-renders labels. There's a history of
  JS-thread freezes here — do **not** propose per-frame heavy work, or animations/blur that would repin
  the thread. (`ArOverlay.tsx` documents the 20 fps cap and why.)
- **RN/Expo components only** — avoid heavy native deps (e.g. custom steppers are used deliberately
  instead of a native slider).

## Current design language (keep the spirit, sharpen the execution)

A coherent **dark HUD / tactical-instrument** aesthetic: deep navy `#0B1622` ground, cyan `#78C8FF`
primary accent, translucent chips with hairline borders, ticks + leader lines, range rings, cardinal
(N/E/S/W) compass hints, status dots, and DEMO/LIVE badges.

**Entity type is encoded by an accent family** — this semantic separation is a strength; keep it:

| Entity | Accent | Icon family |
|---|---|---|
| Aircraft | blue `#78C8FF` | MaterialCommunityIcons, by ADS-B category |
| Vessel (ship/AtoN) | teal/green `#3FC9B0` (+ class variants) | MaterialCommunityIcons |
| Satellite | violet `#C792EA` | `satellite-variant` |

Status signal colors: ok/green `#7CFC9A`, warn/amber `#FFD37C`, error/red `#FF8A80`. Tabs use Ionicons;
system font throughout.

## Surfaces to review (files)

- **AR overlay (the hero):** `app/app/index.tsx`, `app/src/components/ArOverlay.tsx`,
  `AircraftLabel.tsx`, `VesselLabel.tsx`, `SatelliteLabel.tsx`, `StatusStrip.tsx`, `CompassCalibration.tsx`.
- **Map / radar:** `app/app/map.tsx` (+ `map.web.tsx`), `MapViewToggle.tsx`, `AircraftRadar.tsx`,
  `src/components/webmap/LeafletMap.tsx`.
- **List:** `app/app/list.tsx`. **Settings:** `app/app/settings.tsx` (+ `src/state/settingsStore.ts`).
  **Sign-in:** `app/app/sign-in.tsx`.
- **Detail sheets:** `DetailSheet.tsx` (aircraft), `SatelliteDetailSheet.tsx`.
- **Entity color/icon logic:** `src/components/aircraftIcon.ts`, `src/components/vesselIcon.ts`.

## Known rough edges (validate, prioritize, and add your own)

1. **No design-token system.** Every color/size is a hardcoded literal per file. `SAT_VIOLET = #C792EA`
   is copy-pasted in 3 files; the vessel palette lives as local consts in one. High drift risk.
2. **Marker color inconsistency.** Aircraft are blue everywhere **except the native map**, where they're
   amber `#FFB450`. The same blue appears as both `#78C8FF` and `rgba(120,200,255,…)`; error red as both
   `#FF8A80` and `#ff8a80`.
3. **Missing empty / first-run states.** List, Radar, and the AR overlay show nothing (or "Traffic (0)")
   with no "waiting for GPS fix / no traffic in range" guidance.
4. **No onboarding or permission priming.** Camera denial degrades silently to a synthetic horizon; no
   explanation of demo vs live, or what the trust indicators (GPS `±N m`, Compass Unreliable→High) mean.
5. **Interaction asymmetry.** Aircraft and satellites are tappable → detail sheets; **vessels are
   non-interactive everywhere** (no vessel detail sheet yet). Unpredictable affordance.
6. **Glyph overloading + colorblind risk.** Passenger/cargo/tanker/high-speed ships all share the
   `ferry` glyph, distinguished **only by color**; the whole entity system leans on hue. Consider
   shape + color redundancy.
7. **Ad-hoc spacing/radii** (4/6/8/10/12/18, varied paddings) — no scale.
8. **Steppers for wide continuous ranges** (radius 10–400 in steps of 10) are slow to operate — but a
   native slider is a dependency tradeoff; suggest within RN/Expo means.

## What I want from you

Prioritized, **Skylens-specific** recommendations — ideally with quick mockups/specs and an effort-vs-impact
call on each:

1. **AR HUD legibility in daylight** — label density, contrast, declutter behavior, and the status strip.
   This is the product; it has to be readable at arm's length in sun.
2. **A concrete design-token proposal** (colors / spacing / type scale / radii) that captures the current
   look, fixes the inconsistencies above, and is **colorblind-safer** (shape + color redundancy for the
   three entity families).
3. **Empty / loading / first-run / permission states** and light onboarding (demo vs live, what the trust
   indicators mean).
4. **Consistency + affordance fixes** — marker colors across views, vessel tappability, tap-target sizes.
5. Anything that makes it feel **more polished/premium** while staying true to the HUD aesthetic and the
   performance constraints above.

Keep the tactical-HUD identity and the entity color semantics; refine rather than reskin.
