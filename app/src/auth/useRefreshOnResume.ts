/**
 * Native: refresh an expired access token as soon as the app returns to the foreground.
 *
 * Android pauses JS timers in the background, so after a long break the root layout's 60 s refresh
 * timer has not run and the stored token is stale. Without this, the first REST calls and the hub
 * reconnect after resuming would each find that out on their own (they all share the one
 * single-flight refresh, so this is a head start, not a second refresh path). It is also where a
 * session the IdP ended while the app was away shows up as signed out, with the reason.
 *
 * Web keeps its own behaviour: the timer and the on-demand refresh in every caller.
 */

import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { ensureFreshAccessToken } from "./refresh";

export function useRefreshOnResume(): void {
  useEffect(() => {
    if (Platform.OS === "web") return;
    let last: string | null | undefined = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && last !== "active") void ensureFreshAccessToken();
      last = next;
    });
    return () => sub.remove();
  }, []);
}
