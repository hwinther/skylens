# Antenna rotator concept — az/el tracking driven by skylens (draft 2026-07-15)

Goal: an X+Y (azimuth + elevation) stepper-driven directional antenna that points at and follows
objects skylens already tracks — satellites first (weather imagery, amateur downlinks), with the
Moon (EME), fixed radio sources (drift/transit observing) and aircraft as secondary targets. The
app becomes the remote control; a small tracker service near the antenna does the pointing.

**Core insight:** skylens already computes everything a rotator consumes — az/el at ~1 Hz for
satellites (SGP4 + smoothing), Moon (the EME panel literally prints "Antenna el / az"), fixed radio
sources (transit times), and aircraft (ADS-B → az/el in the AR pass) — plus Doppler-corrected
downlink frequencies from the SatNOGS transmitter DB. The rotator is an AR label made physical.
The observer for all math becomes the rotator site's fixed lat/lon/alt, not the phone.

## 1. Architecture

```
skylens app ── "Track <target>" ──▶ skylens-api ──▶ tracker service (edge Pi, at/near antenna)
                                                        │  SGP4/astronomy at 1 Hz, look-ahead,
                                                        │  deadband, flip logic
                                                        ├──▶ rotctld (Hamlib) ──▶ rotator controller ──▶ steppers
                                                        └──▶ rigctld  (Hamlib) ──▶ SDR tuning (Doppler)
```

- **Speak `rotctld`** (Hamlib rotator daemon, plain TCP text: `P <az> <el>`). It is the de-facto
  standard — any commercial or DIY rotator with a rotctld-compatible controller works, and Gpredict
  can drive the same hardware as a fallback/cross-check. Do NOT invent a protocol.
- **Tracker service** runs on an edge node (the edge-sdr RPis are candidates — SDRs already there).
  Input: target spec (`norad:25544` | `moon` | `radio:cas-a` | `hex:47XXXX`) + site coords. It owns
  the control loop; skylens-api only relays start/stop/status. Keep it a separate small daemon so
  antenna experiments never destabilize the gateway.
- **skylens integration:** a "Track" button on the satellite / Moon(EME) / radio-source detail
  sheets; status chip (tracking / slewing / parked); the pass timeline the app already renders is
  the session UI. Config: one or more rotator sites (name, lat/lon/alt, rotctld host:port).

### Tracking-loop details that matter
- **Deadband ~1°:** don't chase SGP4/backlash jitter; command a move only when |error| exceeds the
  beamwidth-informed threshold. Look ahead 2–5 s so the dish leads the target.
- **Keyhole problem:** a near-zenith pass needs a near-instant 180° azimuth slew at culmination.
  Standard fix: when a pass's max elevation exceeds ~80°, run it in **flip mode** (az rotated 180°,
  el = 180° − el) so the mount sails through zenith without the slew. Requires el travel to 180°.
- **Cable wrap:** azimuth end-stops (e.g. 0–450° with limit switches) and an unwrap move between
  passes, or slip rings. Choose during mechanical design; the loop must know the wrap limits.
- **Parking:** between sessions park at a fixed az/el (north/horizon, or meridian for drift scans).

## 2. Hardware candidates

| Option | Cost | Notes |
| --- | --- | --- |
| **SatNOGS rotator v3** (open hardware) | ~$150–300 parts | NEMA17 steppers + worm gears, 3D-printed; the community standard for exactly this use. Controller speaks rotctld. We already consume SatNOGS transmitter data — joining the ecosystem also enables contributing observations later. **Recommended starting point.** |
| ESP32 + 2× TMC2209 + worm gearboxes (scratch DIY) | ~$80–150 | Max freedom; must implement a rotctld-compatible endpoint (existing firmware projects do this). More engineering, less community support. |
| Yaesu G-5500DC (commercial az/el) | ~$700+ | Proven mechanics, handles a real yagi in wind; add a GS-232/rot2prog interface for rotctld. Buy-not-build fallback. |

Mechanical realities: wind load on a yagi is the sizing driver; backlash is why the worm gear +
deadband combo matters; weatherproof the enclosure and connectors; mast with a clear horizon
(especially north–south for polar-orbiter passes). Calibration = level the mount + set true north —
the same Polaris math the app's calibration feature uses applies physically (point at Polaris,
offset ≈ azimuth error; Polaris elevation ≈ site latitude as the sanity check).

## 3. What to receive (justifies the build)

### Satellites — the killer app is L-band HRPT
- **NOAA / Meteor HRPT @ ~1.7 GHz:** full-resolution weather imagery direct from polar orbiters.
  This genuinely REQUIRES tracking (dish 80–120 cm or helix + 1.7 GHz LNA + filter; SDR needs
  ~3 MHz bandwidth — RTL-SDR is marginal, Airspy/HackRF class preferred). This is the payload that
  justifies the rotator; nothing else on this list strictly needs one.
- **137 MHz APT/LRPT (NOAA APT, Meteor LRPT):** does NOT need tracking — a fixed QFH/turnstile omni
  receives it fine. Good warm-up project for the SDR chain, wrong justification for motors.
- **Amateur satellites** (already skylens's "amateur"+"stations" groups): ISS APRS/SSTV/voice
  (145.8), FM birds, FUNcube telemetry. Tracking yagi + live Doppler tuning (rigctld fed by the
  Doppler numbers the detail sheet already computes) turns marginal copy into armchair copy.
- **Geostationary (GOES/EUMETSAT relays):** fixed dish, no rotator — separate mini-project.

### Moon & radio astronomy (dish double-duty)
- **EME:** the app's moonbounce panel already provides pointing, echo delay, path-loss vs perigee,
  libration. Listening for other stations' EME signals (JT65/Q65 on 2 m/70 cm/23 cm) is achievable
  well before TX ambitions.
- **Hydrogen line (1420.406 MHz):** park the dish on the meridian and drift-scan; the radio-sky
  feature's transit times (Cas A ~89° at our latitude, galactic plane) schedule the session. Same
  L-band plumbing as HRPT — one dish, two hobbies.

### Aircraft — receivable, but tracking is mostly unnecessary
Aircraft transmit tens of watts line-of-sight; an omni + LNA hears everything the rotator would.
Worth doing on the SDR side regardless:
- **VHF airband AM voice** (118–137 MHz): tower/approach. The airports feature already shows each
  field's TWR/ATIS/APP frequencies → "aircraft near ENGM → tune Gardermoen TWR" is a natural
  automation (aircraft switch to tower inside ~10–30 km — the "close to the airport" intuition).
- **ACARS** (131.725 MHz eu) / **VDL Mode 2** (136.975 MHz): datalink bursts — OOOI events, gate
  assignments, wx requests. Decode with `acarsdec` / `dumpvdl2`; feeds could even join the MQTT bus
  alongside ADS-B/AIS later.
- Already have: 1090 MHz ADS-B. A tracked yagi on airband is a fun demo, not a requirement.

## 4. Phasing

1. **Phase 0 — this doc:** pick hardware candidate, site survey (horizon, mast, cable run), BOM.
2. **Phase 1 — software only:** tracker service speaking rotctld against Hamlib's **simulator**
   (`rotctld -m 1`); "Track" button + status in skylens; pass-follow logic incl. flip/keyhole and
   deadband, fully testable with zero hardware. Deliverable: watch the simulated dish follow an ISS
   pass end-to-end from the app.
3. **Phase 1.5 — servo pan-tilt prototype (already-owned hobby servos, ~$0):** the classic
   HC-SR04/camera pan-tilt bracket + an ESP32 running the rotctld-subset firmware in
   **`firmware/rotator-esp32/`** (WiFi TCP :4533, `P az el` / `p` / `S` / `K`, slew-rate limiting,
   idle detach, mDNS `rotator.local`) — the Phase-1 tracker service (or Gpredict, today) drives it
   UNCHANGED; only the last inch of hardware is toy-grade.
   - Payload: a laser pointer or phone camera first — visually track the Moon, a dusk ISS pass, or
     aircraft on approach (an ADS-B-driven plane-following camera is a great artifact on its own);
     a small L-band patch (~50–100 g) later.
   - **Full-sky trick:** 180° pan + 0–180° tilt covers the whole hemisphere (anything behind =
     az−180°, el flipped past 90°) — which forces exactly the flip-mode code the real rotator
     needs for keyhole passes anyway. Building the toy debugs the real control loop.
   - Speed is trivial (LEO peaks ~1°/s across the sky; hobby servos do 60°/0.15 s). Slop of
     1–3° is fine vs real antenna beamwidths (even a 1 m dish at 1.7 GHz has a ~12° beam).
     Limits: no dish/yagi mass (SG90 ≈ 1.8 kg·cm, MG996R ≈ 10 kg·cm), indoor/balcony use, servo
     jitter when holding position — all acceptable for validating math + calibration end-to-end.
4. **Phase 2 — build:** SatNOGS v3 (or chosen alternative), bench-calibrate, mount, true-north +
   level calibration, dry-track passes and verify against the AR view (phone and dish should agree).
5. **Phase 3 — receive chain:** 137 MHz omni first (proves SDR pipeline), then L-band dish + LNA
   for HRPT; rigctld Doppler tuning; automated pass recording (cron on the pass predictions —
   effectively a private SatNOGS station).

## 5. Open questions (decide at phase 0/1)

- Which edge node hosts the tracker (existing edge-sdr Pi vs a new one at the mast)?
- Dish vs crossed-yagi first (HRPT dish favors L-band; yagi favors 2 m/70 cm amateur work)?
- El travel 0–90° (simpler) vs 0–180° (enables flip mode — strongly preferred for high passes)?
- One combined "Track" API in skylens-api vs app→tracker direct on LAN (auth story: the JWT the
  app already holds vs tracker-local allowlist)?
- Site: home mast (fixed observer, matches FEED coords) — any HOA/roof constraints?

## 6. References
- SatNOGS rotator v3 wiki + gnuradio flowgraphs (satnogs.org)
- Hamlib rotctld/rigctld protocol docs (`man rotctld`; TCP port 4533/4532 conventions)
- Gpredict (cross-check tool; drives the same rotctld)
- HRPT community resources: usradioguy.com HRPT guides, SDR++ / SatDump decoders
- `acarsdec`, `dumpvdl2` for the airband datalink experiments
