/**
 * Settings: sign in/out, azimuth trim, hFOV calibration (default 66°), subscription
 * radius, mock-auth toggle, and the demo-mode toggle. Calibration values persist to
 * secure-store via the settings store. Steppers are used instead of a native slider
 * to avoid an extra native dependency; the values feed straight into the AR pipeline.
 */

import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSettingsStore } from "@/state/settingsStore";
import { useAuthStore } from "@/state/authStore";
import { useAuth } from "@/auth/useAuth";
import { DEFAULT_HFOV_DEG } from "@/ar/projection";

export default function SettingsScreen() {
  const {
    azimuthTrimDeg,
    hFovDeg,
    radiusKm,
    demoMode,
    setAzimuthTrim,
    setHFov,
    setRadiusKm,
    setDemoMode,
  } = useSettingsStore();
  const status = useAuthStore((s) => s.status);
  const mockMode = useAuthStore((s) => s.mockMode);
  const setMockMode = useAuthStore((s) => s.setMockMode);
  const { signIn, signOut } = useAuth();

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

        <Section title="Demo">
          <Row label="Demo mode (replay + drag-to-look)">
            <Switch value={demoMode} onValueChange={setDemoMode} />
          </Row>
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
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
