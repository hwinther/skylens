/**
 * Settings: sign in/out, azimuth trim, hFOV calibration (default 66°), subscription
 * radius, mock-auth toggle, and the demo-mode toggle. Calibration values persist to
 * secure-store via the settings store. Steppers are used instead of a native slider
 * to avoid an extra native dependency; the values feed straight into the AR pipeline.
 */

import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSettingsStore } from "@/state/settingsStore";
import { useAuthStore } from "@/state/authStore";
import { useAuth } from "@/auth/useAuth";
import { DEFAULT_HFOV_DEG } from "@/ar/projection";
import { ApiClient, getApiBaseUrl } from "@/api";
import { getVersionLine } from "@/lib/version";

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
    showSatellites,
    satAmateurStations,
    satWeather,
    satGnss,
    satElevationMaskDeg,
    showFishingZones,
    showLostGear,
    showPlanets,
    showEcliptic,
    setAzimuthTrim,
    setHFov,
    setRadiusKm,
    setDemoMode,
    setShowShips,
    setShowAton,
    setShowCourseVectors,
    setShowSatellites,
    setSatAmateurStations,
    setSatWeather,
    setSatGnss,
    setSatElevationMaskDeg,
    setShowFishingZones,
    setShowLostGear,
    setShowPlanets,
    setShowEcliptic,
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
          />
        </Section>

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
          <Text style={styles.hint}>
            Sun, Moon and the naked-eye planets in the AR sky, plus the ecliptic — the arc they all
            ride. Computed on-device; no network needed.
          </Text>
        </Section>

        <Section title="Demo">
          <Row label="Demo mode (replay + drag-to-look)">
            <Switch value={demoMode} onValueChange={setDemoMode} />
          </Row>
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
}: {
  label: string;
  value: number;
  unit: string;
  step: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <View style={styles.stepper}>
      <View style={styles.stepperHead}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint && <Text style={styles.hint}>{hint}</Text>}
      </View>
      <View style={styles.stepperControls}>
        <Pressable style={styles.stepBtn} onPress={() => onChange(clamp(value - step))}>
          <Text style={styles.stepBtnText}>−</Text>
        </Pressable>
        <Text style={styles.stepValue}>
          {value}
          {unit}
        </Text>
        <Pressable style={styles.stepBtn} onPress={() => onChange(clamp(value + step))}>
          <Text style={styles.stepBtnText}>+</Text>
        </Pressable>
      </View>
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
  root: { flex: 1, backgroundColor: "#0B1622" },
  content: { padding: 16, gap: 8 },
  title: { color: "#EAF6FF", fontSize: 24, fontWeight: "700", marginBottom: 8 },
  section: {
    backgroundColor: "#0f1e2e",
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    gap: 10,
  },
  sectionTitle: { color: "#78C8FF", fontSize: 13, fontWeight: "700", textTransform: "uppercase" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowLabel: { color: "#EAF6FF", fontSize: 15 },
  rowValue: { color: "#9FC7E0", fontSize: 15, textTransform: "capitalize" },
  aboutValue: { color: "#9FC7E0", fontSize: 15, flexShrink: 1, textAlign: "right", marginLeft: 12 },
  hint: { color: "#5c7a94", fontSize: 12 },
  stepper: { gap: 8 },
  stepperHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  stepperControls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  stepBtn: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: "#16283a",
    alignItems: "center",
    justifyContent: "center",
  },
  stepBtnText: { color: "#EAF6FF", fontSize: 22, fontWeight: "600" },
  stepValue: { color: "#EAF6FF", fontSize: 18, fontWeight: "600", minWidth: 90, textAlign: "center" },
  button: {
    backgroundColor: "#12507a",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonDanger: { backgroundColor: "#5a1f26" },
  buttonText: { color: "#EAF6FF", fontSize: 16, fontWeight: "600" },
});
