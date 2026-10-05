// Per-developer build identity comes from env, never from the repo.
// Put these in packages/mobile/.env.local (gitignored) or your EAS secrets:
//   NOSLEEP_BUNDLE_ID      iOS bundle id + Android package (default dev.nosleep.app)
//   EXPO_APPLE_TEAM_ID     Apple developer team (device builds)
//   EAS_PROJECT_ID         `eas init` project id (EAS Build / OTA updates)
//   EXPO_OWNER             Expo account that owns the EAS project
//   EXPO_PUBLIC_NOSLEEP_URL  optional server URL probed first (e.g. a Tailscale IP)
const { withAndroidManifest } = require("expo/config-plugins");

// Android 9+ blocks plain-HTTP by default; the server is reached over LAN /
// Tailscale on http://<host>:3777, so cleartext must be allowed (iOS does the
// same via NSAllowsArbitraryLoads in app.json).
function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) app.$["android:usesCleartextTraffic"] = "true";
    return cfg;
  });
}

module.exports = ({ config }) => {
  const env = process.env;
  const bundleId = env.NOSLEEP_BUNDLE_ID || config.ios.bundleIdentifier;
  const projectId = env.EAS_PROJECT_ID;

  const next = {
    ...config,
    ...(env.EXPO_OWNER ? { owner: env.EXPO_OWNER } : {}),
    ios: {
      ...config.ios,
      bundleIdentifier: bundleId,
      ...(env.EXPO_APPLE_TEAM_ID ? { appleTeamId: env.EXPO_APPLE_TEAM_ID } : {}),
    },
    android: { ...config.android, package: bundleId },
    ...(projectId
      ? { updates: { url: `https://u.expo.dev/${projectId}` }, extra: { ...config.extra, eas: { projectId } } }
      : {}),
  };
  return withCleartextTraffic(next);
};
