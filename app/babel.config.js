module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      // react-native-reanimated / react-native-worklets plugin must be listed last.
      "react-native-worklets/plugin",
    ],
  };
};
