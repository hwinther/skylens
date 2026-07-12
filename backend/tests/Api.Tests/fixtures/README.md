# Test fixtures

There are two dump1090-fa `aircraft.json` fixtures with different jobs.

## `aircraft-synthetic.json` — deterministic parser contract

A hand-built dump1090-fa `aircraft.json` blob constructed from the documented field format, NOT a real
capture. It deliberately exercises the parser gotchas, and `Dump1090ParserTests` asserts its exact
contents (specific hex/callsign/altitude values, gotcha coverage):

- `4ca7b5` — full, well-formed entry with space-padded `flight` (`"RYR4TZ  "`) and float `seen`/`seen_pos`.
- `471f8d` — `alt_baro: "ground"` (the string sentinel → `OnGround=true`, `AltBaro=null`).
- `45ac52` — position-less aircraft (no `lat`/`lon`; decoded from Mode-S but no CPR fix yet).
- `4b1615` — no `flight` (callsign not yet decoded), positioned.
- `~a3b1c2` — dump1090 prefixes non-ICAO (TIS-B/MLAT) addresses with `~`; minimal fields only.
- `3c6dd2` — large `alt_baro` (`401000`) to confirm no int overflow / rounding surprises.

**Never overwrite this file.** It is the frozen parser contract — changing it breaks the deterministic
assertions on purpose. If the parser needs a new gotcha covered, add a new entry here and a matching
assertion, don't replace the file with a live capture.

## `tle.json` — CelesTrak OMM fixture (satellites vertical)

A JSON object keyed by **CelesTrak GP group name** (`{ "stations": [omm...], "amateur": [omm...],
"weather": [...], "gps-ops": [...], "galileo": [...], "glo-ops": [...], "beidou": [...] }`), each value a
list of verbatim OMM/GP records. This mirrors the `Satellites:TleFile` on-disk format so
`CelestrakTleService.TryLoadFixture` runs the exact same merge/dedupe path as a live fetch cycle. ISS
(NORAD 25544) appears under **both** `stations` and `amateur` — a real CelesTrak crossover — so the
fixture exercises the dedupe precedence (stations wins). ~22 records / 21 distinct satellites: ISS, six
amateur birds (SO-50, RADFXSAT, AO-95, AO-7, AO-27, AO-85), four weather (NOAA 20/21, METEOR-M2 3/4),
and ten GNSS across all four constellations. Records are real captures from CelesTrak.

## `transmitters.json` — SatNOGS transmitters fixture (satellites vertical)

A raw **SatNOGS-shaped** JSON array of transmitter objects (the format
`db.satnogs.org/api/transmitters/?format=json` returns), so `SatNogsClient.TryLoadFixture` parses it
identically to the live API. Contains all ISS transmitters plus transmitters for the fixture's amateur
and weather birds, keeping a mix of `active`/`inactive` so the "best active downlink" summary logic is
exercised (e.g. AO-85's transmitters are all inactive → no summary).

**Data credits:** TLE/OMM data from [CelesTrak](https://celestrak.org/). Transmitter data from the
[SatNOGS DB](https://db.satnogs.org/), licensed **CC BY-SA**.

## `aircraft.json` — real capture

A real `aircraft.json` snapshot captured from the live feed. `Dump1090ParserRealCaptureTests` runs only
**structural** assertions against it (parses without throwing, `now > 0`, at least one aircraft, every
update has a non-empty lowercase hex, the positioned subset is ≤ the total, no update throws on DTO
conversion, numeric altitudes within a sane range). Nothing depends on specific aircraft, so you can
refresh this file at any time without touching the tests:

```bash
mosquitto_sub -h 10.20.13.100 -u skylens -P '<password>' -t adsb/aircraft -C 1 > aircraft.json
```

(The `adsb-mqtt` bridge relays the raw `aircraft.json` verbatim, so the captured payload is drop-in.)
