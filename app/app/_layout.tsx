/**
 * Root layout: wraps the router in the gesture-handler root and safe-area provider,
 * hydrates persisted tokens + settings once, and defines the tab navigation
 * (AR / Map / Settings). The sign-in screen is a modal route outside the tabs.
 */

import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Tabs } from "expo-router";
import { hydrateTokens } from "@/auth/tokenStore";
import { useAuthStore } from "@/state/authStore";

export default function RootLayout() {
  const setStatus = useAuthStore((s) => s.setStatus);

  useEffect(() => {
    (async () => {
      const tokens = await hydrateTokens();
      setStatus(tokens ? "authenticated" : "unauthenticated");
    })();
  }, [setStatus]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Tabs
          screenOptions={{
            headerShown: false,
            tabBarStyle: { backgroundColor: "#0B1622", borderTopColor: "#16283a" },
            tabBarActiveTintColor: "#78C8FF",
            tabBarInactiveTintColor: "#5c7a94",
          }}
        >
          <Tabs.Screen name="index" options={{ title: "AR" }} />
          <Tabs.Screen name="map" options={{ title: "Map" }} />
          <Tabs.Screen name="settings" options={{ title: "Settings" }} />
          <Tabs.Screen name="sign-in" options={{ href: null }} />
        </Tabs>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
