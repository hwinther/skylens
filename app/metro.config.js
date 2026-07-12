// Expo's default Metro config, plus one surgical resolver override for satellite.js.
//
// satellite.js's entry re-exports a WASM runtime we deliberately never use — we only call its
// pure-JS SGP4 path (json2satrec / propagate / gstime / the transforms / dopplerFactor). Its async
// runtime factories `dynamic-import()` the emscripten `#wasm-single-thread` / `#wasm-multi-thread`
// subpaths, and Metro statically follows those specifiers and tries to bundle the emscripten output
// (`wasm-build/*/index.js`), which it can't parse ("Unexpected token require"). Those factories are
// never invoked, so we stub the two virtual specifiers to an empty module — the pure-JS path is
// untouched and the dead WASM weight is dropped from the bundle. (jest resolves satellite.js via a
// moduleNameMapper in jest.config.js and never hits this.)
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "#wasm-single-thread" || moduleName === "#wasm-multi-thread") {
    return { type: "empty" };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
