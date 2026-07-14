# rotator-esp32 — servo pan/tilt rotator speaking rotctld

Phase 1.5 of [docs/rotator-concept.md](../../docs/rotator-concept.md): an ESP32 + the classic
two-servo camera/HC-SR04 pan-tilt bracket become a Hamlib-rotctld-compatible az/el rotator on TCP
`:4533`. Anything that drives a real rotator (the future skylens tracker service, Gpredict,
`rotctl`) drives this bracket unchanged.

## Wiring

| Signal | Pin |
| --- | --- |
| Pan (azimuth) servo signal | GPIO 18 |
| Tilt (elevation) servo signal | GPIO 19 |
| Status LED | GPIO 2 (builtin) |

- Servo **5 V comes from an external supply** (USB power bank / BEC) — a stalled SG90 browns out
  the ESP32's onboard regulator. **All grounds common** (supply GND ↔ ESP32 GND ↔ servo GND).
- ESP32's 3.3 V signal level drives SG90 / MG996R inputs fine.

## Build & flash

1. Arduino IDE (or arduino-cli) with the ESP32 board package; install the **ESP32Servo** library.
2. `cp secrets.example.h secrets.h`, fill in WiFi credentials (secrets.h is gitignored).
3. Adjust the config block if needed: pins, per-servo pulse range (µs at 0°/180°), `PAN_REVERSED`
   / `TILT_REVERSED`, `MOUNT_AZ_OFFSET_DEG` (the compass azimuth pan=0 faces after mounting),
   `TILT_MAX_DEG` + `FLIP_ENABLED` (see below), slew rate, park position.
4. Flash. Serial monitor at 115200 shows the IP; mDNS advertises `rotator.local`.

## Full-sky flip

A 180° pan servo covers half the azimuth circle; targets in the rear half are reached
**over the top**: `(az − 180°, 180° − el)` with the tilt servo passing beyond 90°. This is the
same flip-mode logic real rotators use for keyhole passes. If your bracket's tilt physically
stops near 90°, set `TILT_MAX_DEG` accordingly and `FLIP_ENABLED false` — rear-sky targets are
then rejected with `RPRT -1` and only the front hemisphere is reachable.

## Protocol (rotctld subset)

One command per line on TCP `:4533` — `P <az> <el>` (set), `p` (get → `az\nel`), `S` (stop),
`K` (park), `_` (info), `q` (quit), plus the `\set_pos`-style long forms. Set replies `RPRT 0`
on success, `RPRT -1` on parse/unreachable.

## Test it

```bash
# Hamlib CLI (model 2 = NET rotctl):
rotctl -m 2 -r rotator.local:4533
Rotator command: P 180 45
Rotator command: p

# Or raw:
printf 'P 90 30\np\n' | nc rotator.local 4533
```

Point Gpredict's rotator interface at `rotator.local:4533` and it tracks passes today, before any
skylens-side tracker exists.

## Behaviour notes

- Commands set a **target**; a 50 Hz ticker slews toward it at `MAX_DEG_PER_SEC` (default 90°/s,
  wrap-aware in azimuth) — gentle on gears, and far faster than any LEO pass (~1°/s peak).
- After `IDLE_DETACH_MS` at the target the servos detach (kills hold hum/jitter); any command
  re-attaches. Set 0 to always hold.
- LED: blink = no client, solid = client connected, fast blink = slewing.
- First payloads: a laser pointer or phone camera (visually track the Moon / an ISS pass / an
  approaching aircraft) — validates pointing math + `MOUNT_AZ_OFFSET_DEG` calibration end-to-end
  before any RF.
