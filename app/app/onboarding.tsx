/**
 * First-run onboarding: a one-time 3-step intro (demo vs live → point/calibrate → reading the HUD).
 * Gated in the root layout on the `onboarded` flag after hydration, so it shows once and never flashes
 * for returning users. "Go live" primes the value first, then rides the user tap to request the camera
 * (the native OS-dialog rule). Demo stays the default for skip/demo paths.
 */
import { color } from "@/theme";
import { useState } from "react";
import { Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { router } from "expo-router";
import { useCameraPermissions } from "expo-camera";
import { useSettingsStore } from "@/state/settingsStore";
import { TrustLegend } from "@/components/TrustLegend";

/** Public privacy policy — linked from the live-mode disclosure below (Google prominent-disclosure). */
const PRIVACY_URL = "https://wsh.no/skylens/privacy";

export default function OnboardingScreen() {
  const [step, setStep] = useState(0);
  const setDemoMode = useSettingsStore((s) => s.setDemoMode);
  const setOnboarded = useSettingsStore((s) => s.setOnboarded);
  const [, requestCameraPermission] = useCameraPermissions();

  const finish = (live: boolean) => {
    setDemoMode(!live);
    setOnboarded(true);
    router.replace("/");
  };

  const goLive = async () => {
    setDemoMode(false);
    // Prime already shown on this screen — the OS dialog now rides this tap (native only).
    if (Platform.OS !== "web") {
      try {
        await requestCameraPermission();
      } catch {
        /* denial is handled by the AR banner */
      }
    }
    setStep(1);
  };

  return (
    <SafeAreaView style={styles.root}>
      <Pressable style={styles.skip} onPress={() => finish(false)} hitSlop={8}>
        <Text style={styles.skipText}>Skip</Text>
      </Pressable>

      <View style={styles.body}>
        {step === 0 ? (
          <View style={styles.card}>
            <Text style={styles.kicker}>Welcome to Skylens</Text>
            <Text style={styles.h1}>Demo or live?</Text>
            <View style={styles.choice}>
              <MaterialCommunityIcons name="motion-play" size={20} color={color.status.warn} />
              <View style={styles.choiceBody}>
                <Text style={styles.choiceTitle}>Demo</Text>
                <Text style={styles.choiceSub}>
                  Replayed traffic. Drag to look around — no GPS or camera needed.
                </Text>
              </View>
            </View>
            <View style={styles.choice}>
              <MaterialCommunityIcons name="cctv" size={20} color={color.status.ok} />
              <View style={styles.choiceBody}>
                <Text style={styles.choiceTitle}>Live</Text>
                <Text style={styles.choiceSub}>
                  Real sky. Uses your camera, GPS and compass to place aircraft, ships and satellites
                  where they actually are.
                </Text>
              </View>
            </View>
            <Text style={styles.disclosure}>
              Going live uses your camera and precise location. Your location is sent to Skylens — and,
              when you&apos;re away from home, an aircraft-data provider — to find nearby traffic. It is
              never used for advertising.{" "}
              <Text
                style={styles.link}
                onPress={() => {
                  Linking.openURL(PRIVACY_URL).catch(() => {
                    /* no browser available — non-fatal */
                  });
                }}
              >
                Privacy Policy
              </Text>
            </Text>
            <Pressable style={styles.primary} onPress={goLive}>
              <Text style={styles.primaryText}>Go live</Text>
            </Pressable>
            <Pressable
              style={styles.secondary}
              onPress={() => {
                setDemoMode(true);
                setStep(1);
              }}
            >
              <Text style={styles.secondaryText}>Explore in demo first</Text>
            </Pressable>
          </View>
        ) : step === 1 ? (
          <View style={styles.card}>
            <MaterialCommunityIcons name="compass-outline" size={34} color={color.entity.air} />
            <Text style={styles.h1}>Point &amp; calibrate</Text>
            <Text style={styles.p}>
              Hold the phone up toward the sky. If labels sit off to one side, wave the phone in a
              figure-8 to calibrate the compass, then fine-tune with{" "}
              <Text style={styles.em}>Azimuth trim</Text> in Settings.
            </Text>
            <Text style={styles.p}>
              Bright day? Labels now carry a dark halo so callsigns stay readable against the sky.
            </Text>
            <Pressable style={styles.primary} onPress={() => setStep(2)}>
              <Text style={styles.primaryText}>Next</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.h1}>Reading the HUD</Text>
            <TrustLegend />
            <Text style={styles.p}>
              Toggle layers — ships, aids to navigation, satellites, sky, fishing zones — any time in{" "}
              <Text style={styles.em}>Settings</Text>.
            </Text>
            <Pressable
              style={styles.primary}
              onPress={() => finish(!useSettingsStore.getState().demoMode)}
            >
              <Text style={styles.primaryText}>Start</Text>
            </Pressable>
          </View>
        )}
      </View>

      <View style={styles.dots}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={[styles.dot, i === step ? styles.dotOn : styles.dotOff]} />
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg, padding: 24 },
  skip: { position: "absolute", top: 56, right: 20, zIndex: 2 },
  skipText: { color: color.textDim, fontSize: 14, fontWeight: "600" },
  body: { flex: 1, justifyContent: "center" },
  card: { gap: 14 },
  kicker: {
    color: color.entity.air,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  h1: { color: color.text, fontSize: 24, fontWeight: "700" },
  p: { color: color.textDim, fontSize: 14, lineHeight: 21 },
  em: { color: color.text, fontWeight: "700" },
  choice: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: color.surface,
    borderRadius: 12,
    padding: 14,
  },
  choiceBody: { flex: 1, gap: 3 },
  choiceTitle: { color: color.text, fontSize: 15, fontWeight: "700" },
  choiceSub: { color: color.textDim, fontSize: 13, lineHeight: 19 },
  primary: {
    backgroundColor: color.accentFill,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  primaryText: { color: color.text, fontSize: 16, fontWeight: "700" },
  secondary: { paddingVertical: 10, alignItems: "center" },
  secondaryText: { color: color.entity.air, fontSize: 14, fontWeight: "600" },
  disclosure: { color: color.textMuted, fontSize: 12, lineHeight: 17, marginTop: 4 },
  link: { color: color.entity.air, fontWeight: "700", textDecorationLine: "underline" },
  dots: { flexDirection: "row", gap: 6, justifyContent: "center", paddingBottom: 8 },
  dot: { height: 4, borderRadius: 2 },
  dotOn: { width: 18, backgroundColor: color.entity.air },
  dotOff: { width: 4, backgroundColor: color.surface2 },
});
