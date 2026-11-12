/**
 * Settings: mode (demo/live) and account (sign in/out) at the top, then layers, azimuth trim,
 * hFOV calibration (default 66°), subscription radius and About. Values persist via the settings
 * store (SecureStore on native, localStorage on web). The mock-auth toggle is dev-only. Steppers
 * are used instead of a native slider to avoid an extra native dependency; the values feed straight
 * into the AR pipeline.
 */

import { alpha, color } from "@/theme";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useSettingsStore } from "@/state/settingsStore";
import { useApiAccess, useApiAllowed, useAuthStore, type AuthStatus } from "@/state/authStore";
import type { ApiAccess } from "@/auth/access";
import { useAuth } from "@/auth/useAuth";
import { DEFAULT_HFOV_DEG } from "@/ar/projection";
import { ApiClient, getApiBaseUrl } from "@/api";
import { getVersionLine } from "@/lib/version";

/** Common subscription radii offered as one-tap presets on the Radius stepper. */
const RADIUS_PRESETS = [30, 60, 100, 250] as const;

/** Backend build info fetch state for the About section. */
type BackendState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; version: string; sha: string };

export default function SettingsScreen() {
  const {
    azimuthTrimDeg,
    hFovDeg,
    radiusKm,
    demoMode,
    showShips,
    showAton,
    showCourseVectors,
    showAirports,
    showSmallAirfields,
    showPorts,
    showSatellites,
    satAmateurStations,
    satWeather,
    satGnss,
    satElevationMaskDeg,
    showFishingZones,
    showLostGear,
    showPlanets,
    showEcliptic,
    showRadioSky,
    showSkyEvents,
    setAzimuthTrim,
    setPolarisCalibrating,
    setHFov,
    setRadiusKm,
    setDemoMode,
    setShowShips,
    setShowAton,
    setShowCourseVectors,
    setShowAirports,
    setShowSmallAirfields,
    setShowPorts,
    setShowSatellites,
    setSatAmateurStations,
    setSatWeather,
    setSatGnss,
    setSatElevationMaskDeg,
    setShowFishingZones,
    setShowLostGear,
    setShowPlanets,
    setShowEcliptic,
    setShowRadioSky,
    setShowSkyEvents,
  } = useSettingsStore();
  const status = useAuthStore((s) => s.status);
  const mockMode = useAuthStore((s) => s.mockMode);
  const setMockMode = useAuthStore((s) => s.setMockMode);
  const { signIn, signOut, loading: signInLoading } = useAuth();
  const lastError = useAuthStore((s) => s.lastError);
  const apiAllowed = useApiAllowed();
  const access = useApiAccess();
  const [userName, setUserName] = useState<string | null>(null);

  // The signed-in user's name, from /api/me. Only with a real session; fail-soft.
  useEffect(() => {
    if (status !== "authenticated") return;
    let alive = true;
    new ApiClient({ baseUrl: getApiBaseUrl() })
      .me()
      .then((me) => {
        if (alive) setUserName(me.preferredUsername ?? me.sub ?? null);
      })
      .catch(() => {
        if (alive) setUserName(null);
      });
    return () => {
      alive = false;
    };
  }, [status]);

  const app = useMemo(() => getVersionLine(), []);
  const [backend, setBackend] = useState<BackendState>({ status: "loading" });
  const [showFullSha, setShowFullSha] = useState(false);

  // Backend build info. Prefer /api/version (carries the full sha) when the API may be called;
  // otherwise fall back to the anonymous /healthz `version` field. Fail-soft: any error →
  // "unavailable", never crashes the screen. Re-runs when access changes so signing in upgrades to
  // the full sha.
  useEffect(() => {
    let alive = true;
    const client = new ApiClient({ baseUrl: getApiBaseUrl() });
    (async () => {
      if (apiAllowed) {
        try {
          const v = await client.version();
          if (alive) setBackend({ status: "ok", version: v.version, sha: v.sha });
          return;
        } catch {
          // Fall through to the anonymous health probe.
        }
      }
      try {
        const h = await client.health();
        if (!alive) return;
        setBackend(
          h.version ? { status: "ok", version: h.version, sha: "" } : { status: "error" },
        );
      } catch {
        if (alive) setBackend({ status: "error" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [apiAllowed]);

  const appValue = appVersionValue(app.line, app.sha, showFullSha);
  const backendValue = backendVersionValue(backend, showFullSha);
  const hasFullSha = app.sha.length > 0 || (backend.status === "ok" && backend.sha.length > 0);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Settings</Text>

        <Group title="Mode & account" defaultOpen>
          <Section title="Mode">
            <Row label="Demo mode (replay + drag-to-look)">
              <Switch testID="settings-demo-mode" value={demoMode} onValueChange={setDemoMode} />
            </Row>
            <Text style={styles.hint}>
              {demoMode
                ? "Demo replays recorded traffic with drag-to-look; no account needed. Turn it off for live data."
                : "Live: traffic, ships, airports and satellites from the Skylens server."}
            </Text>
          </Section>

          <Section title="Account">
            <Row label="Status" value={accountStatusText(status, access)} />
            {status === "authenticated" && userName ? <Row label="Signed in as" value={userName} /> : null}
            {__DEV__ ? (
              <Row label="Mock auth (dev only)">
                <Switch value={mockMode} onValueChange={setMockMode} />
              </Row>
            ) : null}
            {lastError && status !== "authenticated" ? (
              <Text testID="settings-signin-error" style={styles.error}>
                {lastError}
              </Text>
            ) : null}
            {status === "authenticated" ? (
              <Button
                testID="settings-signout"
                label="Sign out"
                onPress={() => void signOut()}
                tone="danger"
              />
            ) : (
              <Button
                testID="settings-signin"
                label={signInLabel(status, signInLoading, mockMode)}
                disabled={status === "authenticating" || signInLoading}
                // No await before signIn(): the web popup must open inside this press.
                onPress={() => void signIn()}
              />
            )}
          </Section>
        </Group>

        <Group title="Layers & data" defaultOpen>
          <Section title="Ships">
          <Row label="Show ships">
            <Switch value={showShips} onValueChange={setShowShips} />
          </Row>
          <Row label="Show aids to navigation">
            <Switch value={showAton} onValueChange={setShowAton} />
          </Row>
          <Row label="Course vectors">
            <Switch
              testID="settings-show-course-vectors"
              value={showCourseVectors}
              onValueChange={setShowCourseVectors}
            />
          </Row>
          <Text style={styles.hint}>
            Draw a short predicted-track leader ahead of each moving aircraft (2 min) and ship (15
            min).
          </Text>
        </Section>

        <Section title="Airports">
          <Row label="Show airports">
            <Switch
              testID="settings-show-airports"
              value={showAirports}
              onValueChange={setShowAirports}
            />
          </Row>
          <Row label="Small airfields & heliports">
            <Switch
              testID="settings-show-small-airfields"
              value={showSmallAirfields}
              onValueChange={setShowSmallAirfields}
            />
          </Row>
          <Text style={styles.hint}>
            Airports as reference points — markers + runways on the Map, dim diamonds on the Radar. Large
            and medium airports always show; the second toggle adds small airfields, heliports and
            seaplane bases.
          </Text>
        </Section>

        <Section title="Ports">
          <Row label="Show ports & harbours">
            <Switch testID="settings-show-ports" value={showPorts} onValueChange={setShowPorts} />
          </Row>
          <Text style={styles.hint}>
            Ports, harbours, marinas and ferry quays as reference points on the Map. Norway from
            OpenStreetMap; elsewhere the larger ports from the World Port Index.
          </Text>
        </Section>

        <Section title="Fishing">
          <Row label="Regulation zones">
            <Switch
              testID="settings-show-fishing-zones"
              value={showFishingZones}
              onValueChange={setShowFishingZones}
            />
          </Row>
          <Row label="Lost gear">
            <Switch
              testID="settings-show-lost-gear"
              value={showLostGear}
              onValueChange={setShowLostGear}
            />
          </Row>
          <Text style={styles.hint}>
            Cod boundaries, forbidden/zero areas and reported lost gear. Shown on the fjord/coast Map
            view (not Radar).
          </Text>
        </Section>

        <Section title="Satellites">
          <Row label="Show satellites">
            <Switch
              testID="settings-show-satellites"
              value={showSatellites}
              onValueChange={setShowSatellites}
            />
          </Row>
          <Row label="Amateur + stations">
            <Switch value={satAmateurStations} onValueChange={setSatAmateurStations} />
          </Row>
          <Row label="Weather">
            <Switch value={satWeather} onValueChange={setSatWeather} />
          </Row>
          <Row label="GNSS">
            <Switch value={satGnss} onValueChange={setSatGnss} />
          </Row>
          <Stepper
            label="Elevation mask"
            testID="settings-sat-mask"
            value={satElevationMaskDeg}
            unit="°"
            step={1}
            min={0}
            max={15}
            onChange={setSatElevationMaskDeg}
          />
        </Section>

        <Section title="Sky">
          <Row label="Show planets">
            <Switch
              testID="settings-show-planets"
              value={showPlanets}
              onValueChange={setShowPlanets}
            />
          </Row>
          <Row label="Ecliptic line">
            <Switch
              testID="settings-show-ecliptic"
              value={showEcliptic}
              onValueChange={setShowEcliptic}
            />
          </Row>
          <Row label="Radio sky">
            <Switch
              testID="settings-show-radio-sky"
              value={showRadioSky}
              onValueChange={setShowRadioSky}
            />
          </Row>
          <Row label="Upcoming sky events">
            <Switch
              testID="settings-show-sky-events"
              value={showSkyEvents}
              onValueChange={setShowSkyEvents}
            />
          </Row>
          <Text style={styles.hint}>
            Sun, Moon and the naked-eye planets in the AR sky, plus the ecliptic — the arc they all
            ride. Radio sky adds the fixed hydrogen-line targets (Sgr A*, Cas A, Cyg A, Tau A) for SDR
            observing. Upcoming lists the next equinox, eclipses, oppositions and supermoons. Computed
            on-device; no network needed.
          </Text>
        </Section>
        </Group>

        <Group title="Calibration & sensors">
        <Section title="AR calibration">
          <Stepper
            label="Azimuth trim"
            testID="settings-azimuth-trim"
            value={azimuthTrimDeg}
            unit="°"
            step={1}
            min={-45}
            max={45}
            onChange={setAzimuthTrim}
          />
          <Button
            label="Calibrate with Polaris"
            testID="settings-polaris-calibrate"
            onPress={() => {
              // Arm calibrate mode, then jump to the AR tab where the overlay picks it up.
              setPolarisCalibrating(true);
              router.push("/");
            }}
          />
          <Text style={styles.hint}>
            Point the AR crosshair at Polaris (the North Star, due north at an altitude ≈ your latitude)
            and confirm — the trim above is solved automatically.
          </Text>
          <Stepper
            label="Horizontal FOV"
            testID="settings-hfov"
            value={hFovDeg}
            unit="°"
            step={1}
            min={40}
            max={100}
            onChange={setHFov}
            hint={`default ${DEFAULT_HFOV_DEG}°`}
          />
          <Stepper
            label="Radius"
            testID="settings-radius"
            value={radiusKm}
            unit=" km"
            step={10}
            min={10}
            max={400}
            onChange={setRadiusKm}
            presets={RADIUS_PRESETS}
          />
        </Section>

        </Group>

        <Group title="About">
        <Section title="About">
          <Pressable
            style={styles.row}
            disabled={!hasFullSha}
            onPress={() => setShowFullSha((s) => !s)}
          >
            <Text style={styles.rowLabel}>App</Text>
            <Text style={styles.aboutValue}>{appValue}</Text>
          </Pressable>
          <Pressable
            style={styles.row}
            disabled={!hasFullSha}
            onPress={() => setShowFullSha((s) => !s)}
          >
            <Text style={styles.rowLabel}>Backend</Text>
            <Text style={styles.aboutValue}>{backendValue}</Text>
          </Pressable>
          {hasFullSha && (
            <Text style={styles.hint}>
              {showFullSha ? "Tap to hide full commit hash" : "Tap to reveal full commit hash"}
            </Text>
          )}
        </Section>
        </Group>
      </ScrollView>
    </SafeAreaView>
  );
}

/** The account status in words, including whether this server needs a sign-in at all. */
function accountStatusText(status: AuthStatus, access: ApiAccess): string {
  if (status === "authenticated") return "Signed in";
  if (status === "authenticating") return "Signing in…";
  if (access === "open") return "Not needed on this server";
  if (access === "sign-in-required") return "Signed out";
  return "Checking…";
}

function signInLabel(status: AuthStatus, loading: boolean, mockMode: boolean): string {
  if (status === "authenticating") return "Signing in…";
  if (loading) return "Loading…";
  return mockMode ? "Sign in (mock)" : "Sign in";
}

/** App version cell: reveal the full sha (swapped in for the 7-char short form) when tapped. */
function appVersionValue(line: string, sha: string, showFull: boolean): string {
  if (!line) return "unknown";
  if (!showFull || !sha) return line;
  const short = sha.slice(0, 7);
  return line.includes(short) ? line.replace(short, sha) : `${line} · ${sha}`;
}

/** Backend version cell: "checking…" / "unavailable" / "<version>" or "<version> · <sha>". */
function backendVersionValue(state: BackendState, showFull: boolean): string {
  if (state.status === "loading") return "checking…";
  if (state.status === "error") return "unavailable";
  if (!state.sha) return state.version;
  return `${state.version} · ${showFull ? state.sha : state.sha.slice(0, 7)}`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

/** Collapsible accordion grouping related Sections so the screen stays short as entity families grow. */
function Group({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <View style={styles.group}>
      <Pressable style={styles.groupHead} onPress={() => setOpen((o) => !o)} hitSlop={6}>
        <Text style={styles.groupTitle}>{title}</Text>
        <MaterialCommunityIcons
          name={open ? "chevron-up" : "chevron-down"}
          size={22}
          color={color.textDim}
        />
      </Pressable>
      {open ? <View style={styles.groupBody}>{children}</View> : null}
    </View>
  );
}

function Row({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {value !== undefined ? <Text style={styles.rowValue}>{value}</Text> : children}
    </View>
  );
}

function Stepper({
  label,
  value,
  unit,
  step,
  min,
  max,
  onChange,
  hint,
  presets,
  testID,
}: {
  label: string;
  value: number;
  unit: string;
  step: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  hint?: string;
  presets?: readonly number[];
  /** Prefix for the − / + buttons' testIDs (`<testID>-dec`, `<testID>-inc`). */
  testID?: string;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  // Press-and-hold to repeat. The interval reads the latest value from a ref (a captured `value` would
  // go stale), steps every 120 ms, and stops on release or once it hits min/max.
  const valueRef = useRef(value);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  };
  const startRepeat = (dir: number) => {
    onChange(clamp(value + dir * step)); // immediate first step, so a plain tap still steps once
    stop();
    timer.current = setInterval(() => {
      const next = clamp(valueRef.current + dir * step);
      if (next === valueRef.current) {
        stop(); // reached the bound
        return;
      }
      onChange(next);
    }, 120);
  };
  // Keep the ref fresh for the repeat interval (writing it in render trips react-hooks/refs).
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  return (
    <View style={styles.stepper}>
      <View style={styles.stepperHead}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint && <Text style={styles.hint}>{hint}</Text>}
      </View>
      <View style={styles.stepperControls}>
        <Pressable
          testID={testID && `${testID}-dec`}
          style={styles.stepBtn}
          onPressIn={() => startRepeat(-1)}
          onPressOut={stop}
        >
          <Text style={styles.stepBtnText}>−</Text>
        </Pressable>
        <Text style={styles.stepValue}>
          {value}
          {unit}
        </Text>
        <Pressable
          testID={testID && `${testID}-inc`}
          style={styles.stepBtn}
          onPressIn={() => startRepeat(1)}
          onPressOut={stop}
        >
          <Text style={styles.stepBtnText}>+</Text>
        </Pressable>
      </View>
      {presets ? (
        <View style={styles.presetRow}>
          {presets.map((p) => {
            const active = value === p;
            return (
              <Pressable
                key={p}
                style={[styles.presetChip, active && styles.presetChipActive]}
                onPress={() => onChange(clamp(p))}
              >
                <Text style={[styles.presetChipText, active && styles.presetChipTextActive]}>
                  {p}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function Button({
  label,
  onPress,
  tone,
  testID,
  disabled,
}: {
  label: string;
  onPress: () => void;
  tone?: "danger";
  testID?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      style={[styles.button, tone === "danger" && styles.buttonDanger, disabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { padding: 16, gap: 8 },
  title: { color: color.text, fontSize: 24, fontWeight: "700", marginBottom: 8 },
  group: { marginBottom: 12 },
  groupHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    paddingVertical: 10,
  },
  groupTitle: { color: color.text, fontSize: 17, fontWeight: "700" },
  groupBody: { gap: 8 },
  section: {
    backgroundColor: color.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    gap: 10,
  },
  sectionTitle: { color: color.entity.air, fontSize: 13, fontWeight: "700", textTransform: "uppercase" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowLabel: { color: color.text, fontSize: 15 },
  rowValue: { color: color.textDim, fontSize: 15, textTransform: "capitalize" },
  aboutValue: { color: color.textDim, fontSize: 15, flexShrink: 1, textAlign: "right", marginLeft: 12 },
  hint: { color: color.textMuted, fontSize: 12 },
  stepper: { gap: 8 },
  stepperHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  stepperControls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  stepBtn: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: color.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBtnText: { color: color.text, fontSize: 22, fontWeight: "600" },
  stepValue: { color: color.text, fontSize: 18, fontWeight: "600", minWidth: 90, textAlign: "center" },
  presetRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  presetChip: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(color.entity.air, 0.35),
  },
  presetChipActive: { backgroundColor: color.accentFill, borderColor: color.accentFill },
  presetChipText: { color: color.textDim, fontSize: 13, fontWeight: "600" },
  presetChipTextActive: { color: color.text },
  button: {
    backgroundColor: color.accentFill,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonDanger: { backgroundColor: "#5a1f26" },
  buttonDisabled: { opacity: 0.6 },
  error: { color: color.status.error, fontSize: 13, fontWeight: "600" },
  buttonText: { color: color.text, fontSize: 16, fontWeight: "600" },
});

export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteErrorBoundary";
