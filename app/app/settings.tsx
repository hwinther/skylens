/**
 * Settings: sign in/out, azimuth trim, hFOV calibration (default 66°), subscription
 * radius, mock-auth toggle, and the demo-mode toggle. Calibration values persist to
 * secure-store via the settings store. Steppers are used instead of a native slider
 * to avoid an extra native dependency; the values feed straight into the AR pipeline.
 */

import { alpha, color } from "@/theme";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useSettingsStore } from "@/state/settingsStore";
import { useAuthStore } from "@/state/authStore";
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
    setAzimuthTrim,
    setHFov,
    setRadiusKm,
    setDemoMode,
    setShowShips,
    setShowAton,
    setShowCourseVectors,
    setShowAirports,
    setShowSmallAirfields,
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
  } = useSettingsStore();
  const status = useAuthStore((s) => s.status);
  const mockMode = useAuthStore((s) => s.mockMode);
  const setMockMode = useAuthStore((s) => s.setMockMode);
  const { signIn, signOut } = useAuth();

  const app = useMemo(() => getVersionLine(), []);
  const [backend, setBackend] = useState<BackendState>({ status: "loading" });
  const [showFullSha, setShowFullSha] = useState(false);

  // Backend build info. Prefer /api/version (carries the full sha) when signed in; otherwise fall
  // back to the anonymous /healthz `version` field. Fail-soft: any error → "unavailable", never
  // crashes the screen. Re-runs when auth status changes so signing in upgrades to the full sha.
  useEffect(() => {
    let alive = true;
    const client = new ApiClient({ baseUrl: getApiBaseUrl() });
    (async () => {
      if (status === "authenticated") {
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
  }, [status]);

  const appValue = appVersionValue(app.line, app.sha, showFullSha);
  const backendValue = backendVersionValue(backend, showFullSha);
  const hasFullSha = app.sha.length > 0 || (backend.status === "ok" && backend.sha.length > 0);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Settings</Text>

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
          <Text style={styles.hint}>
            Sun, Moon and the naked-eye planets in the AR sky, plus the ecliptic — the arc they all
            ride. Radio sky adds the fixed hydrogen-line targets (Sgr A*, Cas A, Cyg A, Tau A) for SDR
            observing. Computed on-device; no network needed.
          </Text>
        </Section>
        </Group>

        <Group title="Calibration & sensors">
        <Section title="AR calibration">
          <Stepper
            label="Azimuth trim"
            value={azimuthTrimDeg}
            unit="°"
            step={1}
            min={-45}
            max={45}
            onChange={setAzimuthTrim}
          />
          <Stepper
            label="Horizontal FOV"
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
            value={radiusKm}
            unit=" km"
            step={10}
            min={10}
            max={400}
            onChange={setRadiusKm}
            presets={RADIUS_PRESETS}
          />
        </Section>

        <Section title="Demo">
          <Row label="Demo mode (replay + drag-to-look)">
            <Switch value={demoMode} onValueChange={setDemoMode} />
          </Row>
        </Section>
        </Group>

        <Group title="Account">
        <Section title="Account">
          <Row label="Status" value={status} />
          <Row label="Mock auth (Expo Go)">
            <Switch value={mockMode} onValueChange={setMockMode} />
          </Row>
          {status === "authenticated" ? (
            <Button label="Sign out" onPress={() => void signOut()} tone="danger" />
          ) : (
            <Button label={mockMode ? "Sign in (mock)" : "Sign in"} onPress={() => void signIn()} />
          )}
        </Section>

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
        <Pressable style={styles.stepBtn} onPressIn={() => startRepeat(-1)} onPressOut={stop}>
          <Text style={styles.stepBtnText}>−</Text>
        </Pressable>
        <Text style={styles.stepValue}>
          {value}
          {unit}
        </Text>
        <Pressable style={styles.stepBtn} onPressIn={() => startRepeat(1)} onPressOut={stop}>
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
}: {
  label: string;
  onPress: () => void;
  tone?: "danger";
}) {
  return (
    <Pressable
      style={[styles.button, tone === "danger" && styles.buttonDanger]}
      onPress={onPress}
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
  buttonText: { color: color.text, fontSize: 16, fontWeight: "600" },
});
