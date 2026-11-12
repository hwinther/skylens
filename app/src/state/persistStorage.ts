/**
 * Key/value persistence shared by the settings store and the token store.
 *
 * Native persists to expo-secure-store. Web has no SecureStore (the module is an empty stub there),
 * so it persists to the browser's localStorage instead. Both degrade to an in-memory map when their
 * backend is unreachable (private mode, server render, or jest under plain node with neither a
 * native module nor localStorage), so callers never have to handle a storage failure.
 */

import type { StateStorage } from "zustand/middleware";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const memoryFallback = new Map<string, string>();

type WebKV = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};
// The cast keeps this compiling without the DOM lib in tsconfig; the per-method try/catch falls back
// to memory whenever localStorage is genuinely absent (e.g. on native or under jest).
const web = globalThis as unknown as { localStorage: WebKV };

export const nativeStorage: StateStorage = {
  getItem: async (name) => {
    try {
      return (await SecureStore.getItemAsync(name)) ?? null;
    } catch {
      return memoryFallback.get(name) ?? null;
    }
  },
  setItem: async (name, value) => {
    try {
      await SecureStore.setItemAsync(name, value);
    } catch {
      memoryFallback.set(name, value);
    }
  },
  removeItem: async (name) => {
    try {
      await SecureStore.deleteItemAsync(name);
    } catch {
      memoryFallback.delete(name);
    }
  },
};

export const webStorage: StateStorage = {
  getItem: (name) => {
    try {
      return web.localStorage.getItem(name);
    } catch {
      return memoryFallback.get(name) ?? null;
    }
  },
  setItem: (name, value) => {
    try {
      web.localStorage.setItem(name, value);
    } catch {
      memoryFallback.set(name, value);
    }
  },
  removeItem: (name) => {
    try {
      web.localStorage.removeItem(name);
    } catch {
      memoryFallback.delete(name);
    }
  },
};

/** The storage for this platform: localStorage on web, SecureStore on native. */
export function platformStorage(): StateStorage {
  return Platform.OS === "web" ? webStorage : nativeStorage;
}
