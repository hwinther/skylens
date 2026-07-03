// ESLint 9 flat config. eslint-config-expo ships a flat entrypoint that already
// wires up the RN/TS/import plugins used across the Expo ecosystem. We layer a
// couple of house rules on top and a hard guard that keeps src/ar/ free of any
// react-native import so that pure-TS math stays jest-runnable on Windows.
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  ...expoConfig,
  {
    ignores: ["dist/**", "node_modules/**", ".expo/**", "expo-env.d.ts"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Screens/components fetch on prop change (detail sheet on hex change) — the
    // standard "load + reset then async fetch" effect. The React-Compiler perf hint
    // fights it; same call the pbs-browser frontend makes. Scoped to UI code only.
    files: ["app/**/*.tsx", "src/components/**/*.tsx"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // These two hooks are imperative bridges: they pipe ~60 Hz DeviceMotion samples
    // and drag-gesture updates into refs (the whole point — see the plan's "60 Hz
    // pose stays in refs, never zustand"). The gesture callbacks run on the JS thread
    // via runOnJS, which the react-hooks/refs static check can't follow, so it wrongly
    // flags legitimate ref access. Disable it for just these bridge hooks.
    files: ["src/components/useDemoPose.ts", "src/components/usePoseRefs.ts"],
    rules: {
      "react-hooks/refs": "off",
    },
  },
  {
    // Playwright E2E tooling runs under Node, not the RN app bundle — give it Node globals
    // and drop the app-only import guard.
    files: ["e2e/**/*.ts", "playwright.config.ts"],
    languageOptions: {
      globals: {
        process: "readonly",
        __dirname: "readonly",
        console: "readonly",
      },
    },
    rules: {
      "import/no-extraneous-dependencies": "off",
    },
  },
  {
    // src/ar/ must be pure TypeScript so jest can run it without the RN runtime.
    files: ["src/ar/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react-native", "react-native/*", "expo", "expo-*", "react"],
              message:
                "src/ar/ must stay pure TypeScript (no react-native/expo/react imports) so jest runs it on any platform.",
            },
          ],
        },
      ],
    },
  },
]);
