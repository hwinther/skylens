/**
 * Two jest projects, run together by `npm test`:
 *
 *  - `logic`: the pure-TS logic (AR math, api client parsing, state reducers, mock feed) — none of it
 *    imports the react-native native runtime. jest-expo ships a dedicated `node` preset that runs
 *    under a plain node environment (no winter/native fetch shim) while still applying
 *    babel-preset-expo so TS + path aliases transpile. Fast, deterministic, no device. Files:
 *    `__tests__/*.test.ts` (top level only).
 *  - `native`: component tests that render real screens with @testing-library/react-native on the
 *    full jest-expo preset (the react-native jest runtime and Expo module mocks), in its Android
 *    flavour: Android is the app's native target, so Platform.OS, `.android.*` files and the real
 *    BackHandler behave as on the device (the plain `jest-expo` preset is iOS). Files:
 *    `__tests__/native/**\/*.test.tsx`; shared mocks (maps, camera, sensors, location, router) live in
 *    `__tests__/native/setup.ts`.
 *
 * transformIgnorePatterns keeps the standard jest-expo allowlist so any ESM-only dependency we do
 * import (e.g. @microsoft/signalr) gets transpiled.
 *
 * Reporters and coverage are global options, so they stay at the top level: one junit report and one
 * coverage report for both projects.
 */
const moduleNameMapper = {
  "^@/(.*)$": "<rootDir>/src/$1",
  // satellite.js is ESM-only: its package.json "exports" map exposes only the "import"/"module-sync"
  // conditions (no "require"/"default"), so jest's CommonJS resolver can't find the bare specifier.
  // Map it straight to the built entry; the transformIgnorePatterns allowlist below then lets babel
  // transpile its (and its relative deps') ESM to CJS. We never touch the WASM bulk API — its
  // #wasm-* subpath imports live inside async runtime factories we don't call.
  "^satellite\\.js$": "<rootDir>/node_modules/satellite.js/dist/index.js",
};

const transformIgnorePatterns = [
  "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|@microsoft/signalr|satellite\\.js))",
];

module.exports = {
  projects: [
    {
      displayName: "logic",
      preset: "jest-expo/node",
      testMatch: ["<rootDir>/__tests__/*.test.ts?(x)"],
      moduleNameMapper,
      transformIgnorePatterns,
    },
    {
      displayName: "native",
      preset: "jest-expo/android",
      testMatch: ["<rootDir>/__tests__/native/**/*.test.tsx"],
      setupFilesAfterEnv: ["<rootDir>/__tests__/native/setup.ts"],
      moduleNameMapper,
      transformIgnorePatterns,
    },
  ],
  collectCoverageFrom: [
    "src/**/*.{ts,tsx}",
    "app/**/*.tsx",
    "!src/**/*.d.ts",
    "!src/mock/**",
  ],
  // Jest's istanbul cobertura reporter writes coverage/cobertura-coverage.xml so
  // the reusable pr-build.yml node job (irongut/CodeCoverageSummary) always finds it.
  coverageReporters: ["text", "lcov", "cobertura"],
  // jest-junit emits coverage/junit-report.xml on every jest run so the reusable
  // pr-build.yml node job (dorny/test-reporter, jest-junit parser) always finds it.
  // The PR comment's test summary comes from coverage/json-report.json, written
  // by the coverage:ci script's --json --outputFile flags.
  reporters: [
    "default",
    ["jest-junit", { outputDirectory: "coverage", outputName: "junit-report.xml" }],
  ],
};
