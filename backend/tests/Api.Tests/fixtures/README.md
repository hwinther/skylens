# Test fixtures

## `aircraft.json`

**Synthetic-from-format** — this is a hand-built dump1090-fa `aircraft.json` blob constructed from the
documented field format, NOT a real capture. It deliberately exercises the parser gotchas:

- `4ca7b5` — full, well-formed entry with space-padded `flight` (`"RYR4TZ  "`) and float `seen`/`seen_pos`.
- `471f8d` — `alt_baro: "ground"` (the string sentinel → `OnGround=true`, `AltBaro=null`).
- `45ac52` — position-less aircraft (no `lat`/`lon`; decoded from Mode-S but no CPR fix yet).
- `4b1615` — no `flight` (callsign not yet decoded), positioned.
- `~a3b1c2` — dump1090 prefixes non-ICAO (TIS-B/MLAT) addresses with `~`; minimal fields only.
- `3c6dd2` — large `alt_baro` (`401000`) to confirm no int overflow / rounding surprises.

**TODO (user):** replace with a real capture so the tests exercise live-shaped data:

```bash
mosquitto_sub -h 10.20.13.100 -u skylens -P '<password>' -t adsb/aircraft -C 1 > aircraft.json
```

(The `adsb-mqtt` bridge relays the raw `aircraft.json` verbatim, so the captured payload is drop-in.)
