/**
 * Our tests target the pure-TS logic (AR math, api client parsing, state reducers,
 * mock feed) — none of it imports the react-native native runtime. jest-expo ships a
 * dedicated `node` preset that runs under a plain node environment (no winter/native
 * fetch shim) while still applying babel-preset-expo so TS + path aliases transpile.
 * That is exactly what we want for Windows CI: fast, deterministic, no device.
 *
 * transformIgnorePatterns keeps the standard jest-expo allowlist so any ESM-only
 * dependency we do import (e.g. @microsoft/signalr) gets transpiled.
 */
module.exports = {
  preset: "jest-expo/node",
  testMatch: ["**/__tests__/**/*.test.ts?(x)", "**/?(*.)+(test).ts?(x)"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  collectCoverageFrom: [
    "src/**/*.{ts,tsx}",
    "!src/**/*.d.ts",
    "!src/mock/**",
    "!src/components/**",
  ],
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|@microsoft/signalr))",
  ],
  // jest-junit emits coverage/junit-report.xml on every jest run so the reusable
  // pr-build.yml node job (dorny/test-reporter, jest-junit parser) always finds it.
  reporters: [
    "default",
    ["jest-junit", { outputDirectory: "coverage", outputName: "junit-report.xml" }],
  ],
};
