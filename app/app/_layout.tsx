/**
 * Root layout: wraps the router in the gesture-handler root and safe-area provider,
 * hydrates persisted tokens + settings once, probes whether the backend requires a sign-in, and
 * defines the tab navigation (AR / Map / List / Settings). The sign-in screen is a hidden route.
 */

import { color } from "@/theme";
import { useEffect, useMemo } from "react";
import { Platform, type ColorValue } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { router, Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { probeAuthRequired } from "@/auth/access";
import { ensureFreshAccessToken } from "@/auth/refresh";
import { hydrateTokens, TOKENS_KEY } from "@/auth/tokenStore";
import { useApiAllowed, useAuthStore } from "@/state/authStore";
import { useSettingsStore } from "@/state/settingsStore";
import { useObserverStore } from "@/state/observerStore";
import { SIM_RADIUS_KM, useSimStore } from "@/state/simStore";
import { getApiBaseUrl } from "@/api/config";
import { useLiveFeed, useObserverLocation } from "@/components";
import { ApiIssueBanner } from "@/components/ApiIssueBanner";
import { SignInPrompt } from "@/components/SignInPrompt";

// On web, the OAuth popup redirects back to /oauth inside this same single-page bundle;
// this posts the auth response to the opener and dismisses the popup. No-op on native
// (the native flow calls it from useAuth), and safe to call more than once.
WebBrowser.maybeCompleteAuthSession();

// React Native 0.88 widened ColorValue to include null and packed-ARGB numbers, which Ionicons
// does not accept. The tab tints are always theme strings, so narrow the type here.
const iconColor = (c: ColorValue) => (typeof c === "number" || c == null ? undefined : c);

/**
 * Routes that exist but get no tab button. NOT `href: null`: expo-router 58 turns that into
 * `hidden`, and hidden routes redirect to "/", which made /onboarding, /sign-in and the web OAuth
 * popup's /oauth unreachable. Hiding only the button keeps them navigable.
 */
const HIDDEN_ROUTE = { tabBarItemStyle: { display: "none" } } as const;

/** How often to re-ask whether the backend requires a sign-in while it has given no answer. */
const AUTH_PROBE_RETRY_MS = 5_000;

export default function RootLayout() {
  const setStatus = useAuthStore((s) => s.setStatus);
  const setAuthRequired = useAuthStore((s) => s.setAuthRequired);
  // False while the backend wants a sign-in and there is none (or that's still unknown): then the app
  // makes no API calls at all, and live mode shows the sign-in card instead of a hub that 401s.
  const apiAllowed = useApiAllowed();
  const demoMode = useSettingsStore((s) => s.demoMode);
  const radiusKm = useSettingsStore((s) => s.radiusKm);
  const onboarded = useSettingsStore((s) => s.onboarded);
  const hydrated = useSettingsStore((s) => s._hydrated);
  const baseUrl = useMemo(() => getApiBaseUrl(), []);
  // Baked home coords when present, else a one-shot device/browser geolocation fix. The
  // container/preview web bundles bake no coordinates, so without the geolocation fallback the
  // hub connection would stay connected-but-unsubscribed and no snapshot would ever arrive.
  const observer = useObserverLocation(!demoMode);
  // Publish it so every screen measures from the same position (and the AR screen doesn't trigger
  // a second geolocation request of its own).
  const setObserverPosition = useObserverStore((s) => s.setPosition);
  useEffect(() => {
    setObserverPosition(observer);
  }, [observer, setObserverPosition]);

  // While the simulator follows an aircraft or vessel, centre the subscription on it instead of the
  // observer so it stays in the feed (own feed or away mode) after leaving the observer's radius.
  const simCentre = useSimStore((s) => s.centre);
  const feedCentre = simCentre ?? observer;
  const feedRadiusKm = simCentre ? SIM_RADIUS_KM : radiusKm;

  // App-wide live SignalR feed: populate the shared aircraft store here (not in the AR screen)
  // so every tab — AR and Map — sees the same 1 Hz data regardless of which mounts first. Demo
  // mode leaves this disabled; the AR screen drives the mock feed instead.
  useLiveFeed({
    enabled: !demoMode && apiAllowed,
    baseUrl,
    observer: feedCentre,
    radiusKm: feedRadiusKm,
  });

  useEffect(() => {
    (async () => {
      const tokens = await hydrateTokens();
      setStatus(tokens ? "authenticated" : "unauthenticated");
    })();
  }, [setStatus]);

  // Does the backend require a sign-in? DevAuth (local dev, e2e, previews) answers an anonymous
  // /api/me with 200, real auth with 401. No answer (offline, 5xx) → ask again shortly.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const probe = async () => {
      const required = await probeAuthRequired(baseUrl);
      if (cancelled) return;
      setAuthRequired(required);
      if (required == null) timer = setTimeout(() => void probe(), AUTH_PROBE_RETRY_MS);
    };
    void probe();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [baseUrl, setAuthRequired]);

  // Web: every tab shares the session in localStorage. Follow a sign-in, sign-out or refresh made in
  // another tab (the `storage` event only fires for changes made elsewhere).
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onStorage = (e: { key: string | null }) => {
      if (e.key !== TOKENS_KEY && e.key !== null) return;
      void hydrateTokens().then((tokens) => {
        // Leave an in-progress sign-in in this tab alone; it settles the status itself.
        if (useAuthStore.getState().status === "authenticating") return;
        setStatus(tokens ? "authenticated" : "unauthenticated");
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [setStatus]);

  // Keep the access token fresh app-wide, not only while Settings/Sign-in (useAuth) is mounted.
  // REST calls read the token synchronously; the hub also refreshes on demand at each connect.
  useEffect(() => {
    const id = setInterval(() => void ensureFreshAccessToken(), 60_000);
    return () => clearInterval(id);
  }, []);

  // One-time onboarding: route to it once persisted settings have hydrated and the user hasn't been
  // through it. Waiting on `hydrated` is what stops the intro flashing for returning users.
  useEffect(() => {
    if (hydrated && !onboarded) router.replace("/onboarding");
  }, [hydrated, onboarded]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Tabs
          screenOptions={{
            headerShown: false,
            tabBarStyle: { backgroundColor: color.bg, borderTopColor: color.surface2 },
            tabBarActiveTintColor: color.entity.air,
            tabBarInactiveTintColor: color.textMuted,
          }}
        >
          <Tabs.Screen
            name="index"
            options={{
              title: "AR",
              tabBarIcon: ({ color, size, focused }) => (
                <Ionicons name={focused ? "scan" : "scan-outline"} size={size} color={iconColor(color)} />
              ),
            }}
          />
          <Tabs.Screen
            name="map"
            options={{
              title: "Map",
              tabBarIcon: ({ color, size, focused }) => (
                <Ionicons name={focused ? "map" : "map-outline"} size={size} color={iconColor(color)} />
              ),
            }}
          />
          <Tabs.Screen
            name="list"
            options={{
              title: "List",
              tabBarIcon: ({ color, size, focused }) => (
                <Ionicons name={focused ? "list" : "list-outline"} size={size} color={iconColor(color)} />
              ),
            }}
          />
          <Tabs.Screen
            name="settings"
            options={{
              title: "Settings",
              tabBarIcon: ({ color, size, focused }) => (
                <Ionicons name={focused ? "settings" : "settings-outline"} size={size} color={iconColor(color)} />
              ),
            }}
          />
          <Tabs.Screen name="sign-in" options={HIDDEN_ROUTE} />
          <Tabs.Screen name="oauth" options={HIDDEN_ROUTE} />
          <Tabs.Screen name="onboarding" options={HIDDEN_ROUTE} />
          {/* The simulator is full-screen, so it also drops the tab bar itself. */}
          <Tabs.Screen name="sim" options={{ ...HIDDEN_ROUTE, tabBarStyle: { display: "none" } }} />
        </Tabs>
        {/* Failed REST calls (expired session, server error, offline) shown above every tab. */}
        <ApiIssueBanner />
        {/* Live mode with real auth and no session: sign in, or continue in demo. */}
        <SignInPrompt />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
