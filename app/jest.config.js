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
    // satellite.js is ESM-only: its package.json "exports" map exposes only the "import"/"module-sync"
    // conditions (no "require"/"default"), so jest's CommonJS resolver can't find the bare specifier.
    // Map it straight to the built entry; the transformIgnorePatterns allowlist below then lets babel
    // transpile its (and its relative deps') ESM to CJS. We never touch the WASM bulk API — its
    // #wasm-* subpath imports live inside async runtime factories we don't call.
    "^satellite\\.js$": "<rootDir>/node_modules/satellite.js/dist/index.js",
  },
  collectCoverageFrom: [
    "src/**/*.{ts,tsx}",
    "!src/**/*.d.ts",
    "!src/mock/**",
    "!src/components/**",
  ],
  // Jest's istanbul cobertura reporter writes coverage/cobertura-coverage.xml so
  // the reusable pr-build.yml node job (irongut/CodeCoverageSummary) always finds it.
  coverageReporters: ["text", "lcov", "cobertura"],
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|@microsoft/signalr|satellite\\.js))",
  ],
  // jest-junit emits coverage/junit-report.xml on every jest run so the reusable
  // pr-build.yml node job (dorny/test-reporter, jest-junit parser) always finds it.
  reporters: [
    "default",
    ["jest-junit", { outputDirectory: "coverage", outputName: "junit-report.xml" }],
  ],
};
