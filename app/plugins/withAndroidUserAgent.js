const { withMainApplication } = require("@expo/config-plugins");

// Give the Android app a real User-Agent ("Skylens/<versionName>") instead of React Native's
// default "okhttp/<x>", which our CrowdSec edge gateway 403s. It registers an okhttp interceptor via
// OkHttpClientProvider in MainApplication.onCreate, so every request through RN's networking —
// ApiClient fetch AND expo-auth-session's OIDC discovery/token calls — carries it.
//
// The SignalR hub is WebSocket-only (skipNegotiation) and RN's WebSocket uses a *separate* okhttp
// client this factory doesn't touch, so that handshake's UA is set in src/api/signalr.ts instead.
const MARKER = "SkylensOkHttpClientFactory";

const REGISTER = `    com.facebook.react.modules.network.OkHttpClientProvider.setOkHttpClientFactory(${MARKER}())`;

const FACTORY = `class ${MARKER} : com.facebook.react.modules.network.OkHttpClientFactory {
  override fun createNewNetworkModuleClient(): okhttp3.OkHttpClient {
    return com.facebook.react.modules.network.OkHttpClientProvider.createClientBuilder()
      .addInterceptor { chain ->
        chain.proceed(
          chain.request().newBuilder()
            .header("User-Agent", "Skylens/" + BuildConfig.VERSION_NAME)
            .build()
        )
      }
      .build()
  }
}`;

module.exports = function withAndroidUserAgent(config) {
  return withMainApplication(config, (cfg) => {
    if (cfg.modResults.language !== "kt") {
      throw new Error("[withAndroidUserAgent] expected a Kotlin MainApplication");
    }
    let src = cfg.modResults.contents;
    if (!src.includes(MARKER)) {
      if (!src.includes("super.onCreate()")) {
        throw new Error(
          "[withAndroidUserAgent] could not find super.onCreate() to anchor the factory registration",
        );
      }
      src = src.replace("super.onCreate()", `super.onCreate()\n${REGISTER}`);
      src = `${src.trimEnd()}\n\n${FACTORY}\n`;
    }
    cfg.modResults.contents = src;
    return cfg;
  });
};
