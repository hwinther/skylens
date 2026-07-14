/*
 * rotator-esp32 — hobby-servo pan/tilt rotator speaking the Hamlib rotctld network protocol.
 *
 * Phase 1.5 of docs/rotator-concept.md: an ESP32 + two hobby servos (the classic camera/HC-SR04
 * pan-tilt bracket) become a rotctld-compatible az/el rotator on TCP :4533. The skylens tracker
 * service (or Gpredict, or plain `rotctl -m 2 -r <ip>:4533`) drives it with `P az el`; nothing on
 * the software side knows it's a $5 bracket instead of a SatNOGS mast.
 *
 * Protocol subset (one command per line; the standard rotctld dialect):
 *   P <az> <el>   set position (deg). Reply: "RPRT 0" (or "RPRT -1" on parse/range error)
 *   p             get position.       Reply: "<az>\n<el>"
 *   S             stop (hold current position). Reply: "RPRT 0"
 *   K             park (PARK_AZ/PARK_EL).       Reply: "RPRT 0"
 *   _             info string
 *   q / Q         close the connection
 *   \set_pos / \get_pos / \stop / \park          long-form aliases of the above
 *
 * Full-sky trick (FLIP): a 180° pan servo can't cover 360° of azimuth, but with a 0–180° tilt the
 * far half is reached "over the top": logical (az, el) with az behind the mount maps to
 * (az − 180°, 180° − el). This is the same flip-mode logic a real rotator needs for keyhole
 * passes, so the toy debugs the real control loop. If your bracket's tilt can't pass 90°
 * (FLIP_ENABLED false), the reachable sky is the front half only and rear targets are rejected.
 *
 * Motion: commands set a TARGET; a 50 Hz ticker slews the current logical az/el toward it at
 * MAX_DEG_PER_SEC (wrap-aware shortest path in azimuth), then maps logical → servo microseconds.
 * LEO passes peak around ~1°/s, so the default 90°/s is generous headroom while staying gentle on
 * the gears. Optional IDLE_DETACH_MS releases the servos after the target is held (kills the
 * classic hold jitter/hum); any new command re-attaches.
 *
 * Wiring: servo signal wires → PAN_PIN / TILT_PIN; servo 5 V from an EXTERNAL supply (USB power
 * bank / BEC — an SG90 stall spike browns out the ESP32's regulator); ALL grounds common. The
 * 3.3 V logic level drives SG90/MG996R signal inputs fine.
 *
 * Libraries: ESP32Servo (Arduino Library Manager). Board: any ESP32 dev module.
 */

#include <WiFi.h>
#include <ESPmDNS.h>
#include <ESP32Servo.h>

#include "secrets.h" // WIFI_SSID / WIFI_PASS — copy secrets.example.h, never commit the real one

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

static const char *HOSTNAME = "rotator"; // mDNS: rotator.local
static const uint16_t ROTCTL_PORT = 4533; // rotctld convention

static const int PAN_PIN = 18;  // azimuth servo signal
static const int TILT_PIN = 19; // elevation servo signal
static const int LED_PIN = 2;   // most dev boards' builtin LED

// Servo pulse calibration (µs at 0° / 180°). SG90/MG996R are typically ~500–2500; trim per servo
// if 0°/180° hit the mechanical end stops early.
static const int PAN_MIN_US = 500, PAN_MAX_US = 2500;
static const int TILT_MIN_US = 500, TILT_MAX_US = 2500;

// Flip direction of travel without rewiring (true if the servo runs backwards vs expectation).
static const bool PAN_REVERSED = false;
static const bool TILT_REVERSED = false;

// The compass azimuth (deg) the pan axis points at when the pan servo is at 0°. Set after
// mounting: aim pan=90 at a known bearing and solve, or just point pan=0 due at some azimuth and
// write it here. (The skylens Polaris calibration is the app-side equivalent of this constant.)
static const float MOUNT_AZ_OFFSET_DEG = 0.0f;

// Tilt travel. 180 enables the over-the-top flip (full-sky from a 180° pan). If the bracket
// physically stops at ~90°, set TILT_MAX_DEG accordingly and FLIP_ENABLED false.
static const float TILT_MAX_DEG = 180.0f;
static const bool FLIP_ENABLED = true;

// Logical elevation limits accepted from clients (deg above horizon).
static const float EL_MIN_DEG = 0.0f, EL_MAX_DEG = 90.0f;

static const float MAX_DEG_PER_SEC = 90.0f; // slew rate in logical space
static const uint32_t TICK_MS = 20;         // 50 Hz motion tick

// Release servos after holding the target this long (0 = never detach). Stops hold hum/jitter.
static const uint32_t IDLE_DETACH_MS = 8000;

static const float PARK_AZ_DEG = 0.0f, PARK_EL_DEG = 0.0f;

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

Servo panServo, tiltServo;
WiFiServer server(ROTCTL_PORT);
WiFiClient client;

static float targetAz = PARK_AZ_DEG, targetEl = PARK_EL_DEG;   // logical, deg
static float currentAz = PARK_AZ_DEG, currentEl = PARK_EL_DEG; // logical, deg (slewed)
static uint32_t lastTickMs = 0;
static uint32_t settledSinceMs = 0; // 0 = not settled
static bool attached = false;
static char lineBuf[96];
static size_t lineLen = 0;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

static float wrap360(float deg) {
  deg = fmodf(deg, 360.0f);
  return deg < 0 ? deg + 360.0f : deg;
}

/** Shortest signed angular difference a→b in (−180, 180]. */
static float shortestDelta(float fromDeg, float toDeg) {
  float d = fmodf(toDeg - fromDeg + 540.0f, 360.0f) - 180.0f;
  return d == -180.0f ? 180.0f : d;
}

static void attachServos() {
  if (attached) return;
  panServo.setPeriodHertz(50);
  tiltServo.setPeriodHertz(50);
  panServo.attach(PAN_PIN, PAN_MIN_US, PAN_MAX_US);
  tiltServo.attach(TILT_PIN, TILT_MIN_US, TILT_MAX_US);
  attached = true;
}

static void detachServos() {
  if (!attached) return;
  panServo.detach();
  tiltServo.detach();
  attached = false;
}

static int degToUs(float deg, int minUs, int maxUs, bool reversed) {
  deg = constrain(deg, 0.0f, 180.0f);
  if (reversed) deg = 180.0f - deg;
  return minUs + (int)((deg / 180.0f) * (float)(maxUs - minUs));
}

/**
 * Map logical (az, el) to servo (pan, tilt) degrees, using the over-the-top flip for the rear
 * half-sky. Returns false when the target is mechanically unreachable (rear target with flip
 * disabled, or tilt beyond the bracket's travel).
 */
static bool logicalToServo(float az, float el, float &panDeg, float &tiltDeg) {
  float rel = wrap360(az - MOUNT_AZ_OFFSET_DEG); // azimuth relative to the pan axis zero
  if (rel <= 180.0f) {
    panDeg = rel;
    tiltDeg = el;
  } else if (FLIP_ENABLED) {
    panDeg = rel - 180.0f;
    tiltDeg = 180.0f - el; // over the top
  } else {
    return false;
  }
  return tiltDeg >= 0.0f && tiltDeg <= TILT_MAX_DEG;
}

static void driveServos() {
  float panDeg, tiltDeg;
  if (!logicalToServo(currentAz, currentEl, panDeg, tiltDeg)) return; // hold last good pose
  attachServos();
  panServo.writeMicroseconds(degToUs(panDeg, PAN_MIN_US, PAN_MAX_US, PAN_REVERSED));
  tiltServo.writeMicroseconds(degToUs(tiltDeg, TILT_MIN_US, TILT_MAX_US, TILT_REVERSED));
}

// ---------------------------------------------------------------------------------------------
// rotctld protocol
// ---------------------------------------------------------------------------------------------

static void reply(const char *s) {
  if (client && client.connected()) client.print(s);
}

/** Accept a target if reachable; RPRT accordingly. */
static void handleSetPos(float az, float el) {
  az = wrap360(az);
  if (el < EL_MIN_DEG || el > EL_MAX_DEG) {
    reply("RPRT -1\n");
    return;
  }
  float p, t;
  if (!logicalToServo(az, el, p, t)) {
    reply("RPRT -1\n"); // rear sky with flip disabled / beyond tilt travel
    return;
  }
  targetAz = az;
  targetEl = el;
  settledSinceMs = 0;
  attachServos();
  reply("RPRT 0\n");
}

static void handleLine(char *line) {
  // Trim leading whitespace and a leading '+' (extended-response prefix some clients send).
  while (*line == ' ' || *line == '\t' || *line == '+') line++;
  size_t n = strlen(line);
  while (n && (line[n - 1] == '\r' || line[n - 1] == ' ')) line[--n] = 0;
  if (!n) return;

  // Long-form aliases → short commands.
  if (line[0] == '\\') {
    if (strncmp(line, "\\set_pos", 8) == 0) { line += 7; *line = 'P'; }
    else if (strcmp(line, "\\get_pos") == 0) line = (char *)"p";
    else if (strcmp(line, "\\stop") == 0) line = (char *)"S";
    else if (strcmp(line, "\\park") == 0) line = (char *)"K";
    else if (strcmp(line, "\\get_info") == 0) line = (char *)"_";
  }

  switch (line[0]) {
    case 'P': { // P <az> <el>
      float az, el;
      if (sscanf(line + 1, "%f %f", &az, &el) == 2) handleSetPos(az, el);
      else reply("RPRT -1\n");
      break;
    }
    case 'p': { // get_pos → two lines
      char out[40];
      snprintf(out, sizeof(out), "%.2f\n%.2f\n", currentAz, currentEl);
      reply(out);
      break;
    }
    case 'S': // stop: hold where we are
      targetAz = currentAz;
      targetEl = currentEl;
      reply("RPRT 0\n");
      break;
    case 'K': // park
      handleSetPos(PARK_AZ_DEG, PARK_EL_DEG);
      break;
    case '_':
      reply("Info skylens rotator-esp32 servo pan-tilt\n");
      break;
    case 'q':
    case 'Q':
      client.stop();
      break;
    default:
      reply("RPRT -1\n");
  }
}

static void pumpClient() {
  if (!client || !client.connected()) {
    client = server.accept();
    if (client) {
      lineLen = 0;
      Serial.printf("[net] client %s connected\n", client.remoteIP().toString().c_str());
    }
    return;
  }
  while (client.available()) {
    char c = (char)client.read();
    if (c == '\n') {
      lineBuf[lineLen] = 0;
      handleLine(lineBuf);
      lineLen = 0;
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    } else {
      lineLen = 0; // oversized garbage — drop the line
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Motion tick
// ---------------------------------------------------------------------------------------------

static void tickMotion() {
  uint32_t now = millis();
  if (now - lastTickMs < TICK_MS) return;
  float dt = (now - lastTickMs) / 1000.0f;
  lastTickMs = now;

  float step = MAX_DEG_PER_SEC * dt;
  float dAz = shortestDelta(currentAz, targetAz);
  float dEl = targetEl - currentEl;
  bool moving = fabsf(dAz) > 0.05f || fabsf(dEl) > 0.05f;

  if (moving) {
    currentAz = wrap360(currentAz + constrain(dAz, -step, step));
    currentEl += constrain(dEl, -step, step);
    driveServos();
    settledSinceMs = 0;
  } else if (settledSinceMs == 0) {
    currentAz = targetAz; // snap the last fraction
    currentEl = targetEl;
    driveServos();
    settledSinceMs = now;
  } else if (IDLE_DETACH_MS > 0 && attached && now - settledSinceMs > IDLE_DETACH_MS) {
    detachServos(); // stop hold hum; next command re-attaches
  }

  // LED: solid = client connected, blink = no client, double-rate blink while slewing.
  bool connected = client && client.connected();
  uint32_t period = moving ? 150 : 600;
  digitalWrite(LED_PIN, connected && !moving ? HIGH : ((now / period) % 2 ? HIGH : LOW));
}

// ---------------------------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);

  // ESP32Servo needs its timers allocated once before any attach.
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOSTNAME);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[wifi] connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
    Serial.print(".");
    digitalWrite(LED_PIN, (millis() / 100) % 2 ? HIGH : LOW);
  }
  Serial.printf("\n[wifi] %s  ip=%s\n", WIFI_SSID, WiFi.localIP().toString().c_str());

  if (MDNS.begin(HOSTNAME)) MDNS.addService("rotctld", "tcp", ROTCTL_PORT);

  server.begin();
  server.setNoDelay(true);
  Serial.printf("[net] rotctld on %s.local:%u\n", HOSTNAME, ROTCTL_PORT);

  attachServos();
  driveServos(); // park pose
  lastTickMs = millis();
}

void loop() {
  pumpClient();
  tickMotion();

  // WiFi resilience: the ESP32 auto-reconnects, but nudge it if it lingers disconnected.
  static uint32_t lastWifiCheck = 0;
  if (millis() - lastWifiCheck > 10000) {
    lastWifiCheck = millis();
    if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
  }
}
