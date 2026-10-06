# NoSleep Mobile App

`packages/mobile` is an Expo SDK 55 / React Native 0.83 app for monitoring and
steering NoSleep from your phone. It talks to the same server as the web
dashboard (HTTP on `:3777` plus a WebSocket on `/ws`). It has no backend of its
own.

| Platform | Status |
|---|---|
| iOS | Used daily |
| Android | **Beta.** It builds and runs on the same code, but gets much less testing |

## Screens

Five bottom tabs: **Dashboard · Projects · Brain · Alerts · More**, with a mic
button docked in the centre of the tab bar for quick voice notes (it opens a
capture sheet without leaving the current screen).

| Screen | Where | What you can do |
|---|---|---|
| Dashboard | tab | Projects grouped by org with running sessions, an active on/off switch per project, a *Stop* button on running sessions, and an unacked-alert banner. Tap a session to open its Terminal |
| Projects | tab | All projects grouped by org. Tap one to open Launch |
| Launch | from Projects | Start a session with a goal and acceptance criteria, or turn on *auto* to prefill from the strategy tree's next actionable task |
| Session | stack | Goal, criteria, progress, elapsed time, tokens, recent alerts, and *Stop* / *Redirect* (send a steering message) |
| Terminal | from Dashboard | A structured live transcript (you / claude / command / output rows) backfilled from Brain artifacts and appended from WebSocket events. Input sends a Redirect. Sticky-bottom only applies when you are already at the bottom |
| Brain → Search | tab | Hybrid lexical + semantic search across the Brain, scoped to a project or the whole org. Tap a result to open the artifact. Long-press copies its hash |
| Brain → Capture | tab | Capture a thought (text, voice, optional photo) to the Brain or as a new strategy node under a chosen parent. While offline, drafts are queued and retried |
| Brain artifact / session | stack | Kind-aware viewer for one artifact, or for all artifacts of one session in order |
| Alerts | tab | Alert list with org filter and acknowledge. The tab badge shows the unacked count, polled every 15 s and pushed over WebSocket, with a haptic on new alerts |
| Strategy / Strategy node | More | Pick a project, drill down the tree, change node status, add child nodes, view dependencies |
| Schedules | More | Scheduled tasks grouped by project. Enable or disable each one, or disable all |
| Token Usage | More | Per-org budget bars and top sessions by tokens. Refreshes on WebSocket budget events |
| Metrics | More | Sessions, tokens, drift, escalations and validation outcomes over 1h / 6h / 24h / 7d, filterable by org |
| Settings | More | API key, manual server URL, *Rediscover Server*, API/WS status, *Register push* |

**Mic button:** tap it to open a compact dictation sheet that sends to the
Brain or to the strategy tree. Long-press starts recording straight away. It
remembers the last org and project. The first time, it uses `org_personal` and
the org-wide Brain bucket, and the strategy destination stays disabled until
you pick a real project.

Client errors and boot diagnostics are posted to the server's
`/api/client-log` endpoint, so you can debug from the Mac instead of the
phone.

## Connecting to the server

### Discovery order (`src/services/discovery.ts`)

| # | Step | Notes |
|---|---|---|
| 0 | **Manual URL** from Settings or the "Server not found" screen | Used as-is, with no health check |
| 1 | **Cached config** from the last successful discovery | Kept only if `GET /health` answers within 2 s |
| 2 | **Quick probes**, raced in parallel (first healthy one wins, about 2 s) | `EXPO_PUBLIC_NOSLEEP_URL` (if set at build time), `http://localhost:3777`, and on the phone's /24 subnet: `.1`, `.2`, `.10`, `.100`, `.200` port 3777 |
| 3 | **Full subnet scan** | `.1`–`.254` on the phone's /24, 30 hosts at a time, 1 s timeout each |

The probe is `GET http://<host>:3777/health`, which needs no key. There is no
UDP/mDNS beacon. Discovery is pure HTTP probing. If every step fails, the app
shows **Server not found** with *Retry discovery* and a URL field. The URL
field accepts `100.64.0.7`, `192.168.1.20:3777` or a full `http://` URL, and
adds `http://` and `:3777` if they are missing.

Subnet scanning only finds the server when phone and server are on the same
IPv4 /24. For Tailscale or other networks, set the URL manually or bake it in
with `EXPO_PUBLIC_NOSLEEP_URL`.

### API key

Paste the server's `NOSLEEP_API_KEY` (from the repo `.env`) into
**More → Settings → API Key**. The key is never discovered automatically. It is
sent as `x-api-key` on HTTP and as `?token=` on the WebSocket. Saving a key
clears the cached server config so the next discovery uses it.

The key is sanitized on save: anything that is not an RFC 7230 token character
(whitespace, newlines, smart quotes) is removed. See *Troubleshooting*.

## Push notifications

- Uses `expo-notifications`. After the app connects it asks for permission,
  gets an Expo push token and registers it with `POST /api/push/register`. You
  can repeat this from **Settings → Register push**.
- The server sends through Expo's push service (`exp.host`) whenever alerts
  fire.
- Push tokens are tied to an **EAS project**, so you need your own: run
  `npx eas init` and put the id in `EAS_PROJECT_ID`. Without it the app runs
  normally and simply skips push registration.
- The badge count is set on iOS only.
- Use a development or release build for push. Expo Go's remote-push support
  is limited, and on Android it is absent.

## Voice capture

`src/services/voice.ts` runs two things in parallel:

- **Live speech-to-text** with `expo-speech-recognition` (Apple Speech on iOS,
  `SpeechRecognizer` on Android). It prefers on-device recognition and falls
  back to network recognition.
- **m4a recording** with `expo-audio`, uploaded to the Brain
  (`/api/brain/ingest`) as an audio artifact. If recording fails, the
  transcript still works.

Both modules are loaded lazily. If a native module is missing (for example in
Expo Go, which does not include `expo-speech-recognition`), voice reports
"voice module not installed" and the rest of the app works. Permissions are
declared in `app.json`: microphone and speech recognition on iOS,
`RECORD_AUDIO` on Android.

## Configuration

All per-developer identity lives in `packages/mobile/.env.local`, which is
gitignored, or in EAS secrets. Nothing personal is in the repo. `app.config.js`
reads these over `app.json`:

```bash
cd packages/mobile
cp .env.example .env.local
```

| Variable | Default | Purpose |
|---|---|---|
| `NOSLEEP_BUNDLE_ID` | `dev.nosleep.app` | iOS bundle id **and** Android package |
| `EXPO_APPLE_TEAM_ID` | — | Apple developer team for device builds |
| `EAS_PROJECT_ID` | — | Your `eas init` project id. Enables EAS Update (`updates.url`) and `extra.eas.projectId` |
| `EXPO_OWNER` | — | Expo account that owns the EAS project |
| `EXPO_PUBLIC_NOSLEEP_URL` | — | Server URL added to the quick probes, e.g. `http://100.64.0.7:3777`. Inlined at bundle time, so restart Metro or rebuild after changing it |

All are optional for `npx expo start` in Expo Go. You need them for your own
device and EAS builds.

`app.config.js` also adds a config plugin that sets
`android:usesCleartextTraffic="true"`. Android 9+ blocks plain HTTP by default,
and the server is served over `http://<host>:3777`. iOS gets the equivalent
from `NSAllowsArbitraryLoads` in `app.json`.

## Running it

```bash
cd packages/mobile
npm install            # or from the repo root
```

| Mode | Command | Good for | Limits |
|---|---|---|---|
| Expo Go | `npx expo start`, then scan the QR code | Quick UI work | No voice (`expo-speech-recognition` is not in Expo Go). Push is unreliable or absent |
| Dev client | `npx expo run:ios --device` / `npx expo run:android` | Full native features with Metro hot reload | Needs Xcode / Android Studio. Phone must reach Metro |
| Release (iOS) | `npx expo run:ios --configuration Release --device` | Standalone app on your phone with no Metro | Needs `EXPO_APPLE_TEAM_ID` and Xcode signing |
| Release (Android) | `npx expo run:android --variant release` | Standalone APK on a connected device | Signs with the debug keystore unless you configure your own |

`ios/` and `android/` are generated by prebuild and are gitignored. After
changing `.env.local` identity values, `app.json` plugins or permissions,
regenerate them with `npx expo prebuild --clean`.

### EAS Build

`eas.json` defines three profiles (EAS CLI ≥ 18, remote app versioning):

| Profile | Output | Channel |
|---|---|---|
| `development` | Dev client, internal distribution | `development` |
| `preview` | Internal-distribution device build (no iOS simulator build) | `preview` |
| `production` | Store build with `autoIncrement` | `production` |

```bash
npx eas init                              # once; copy the id into EAS_PROJECT_ID
npx eas build --profile preview --platform ios
npx eas build --profile preview --platform android
```

`runtimeVersion` follows the app version (`policy: appVersion`) for EAS Update.

## Away from home: Tailscale

1. Install Tailscale on the phone and on the server machine, and sign in to the
   same tailnet.
2. On macOS use the **App Store / standalone Tailscale app**, not the Homebrew
   `tailscale` CLI. The Homebrew build runs in userspace-networking mode and
   cannot accept inbound connections, so the phone cannot reach `:3777`.
3. In the app, set the server URL to the Mac's Tailscale IP (e.g.
   `100.64.0.7`), or put it in `EXPO_PUBLIC_NOSLEEP_URL` before building.
4. Set the API key. Non-loopback clients always need it.

Do not expose `:3777` to the public internet. Use a trusted LAN or a tailnet.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **"Network request failed"** on every call, with nothing in server logs | Usually a malformed API key header (trailing newline or smart quotes from a paste). iOS's URL session rejects the request before it leaves the phone. Current builds sanitize the key on save, so re-paste it in Settings. Older stored keys are also sanitized on read |
| 401 / empty lists | API key missing or wrong. Re-paste `NOSLEEP_API_KEY` |
| **Server not found** on LAN | Phone and server are on different subnets, a guest Wi-Fi isolates clients, or the server's host firewall blocks `:3777`. Enter the URL manually |
| Server not found over Tailscale | Homebrew userspace Tailscale on the Mac (see above), or the URL is not the 100.x tailnet IP |
| iOS blocks HTTP (ATS error) | You built without `NSAllowsArbitraryLoads`. It is in `app.json`, so rebuild after `npx expo prebuild --clean` if you edited `ios/` by hand |
| Android blocks HTTP (`CLEARTEXT communication not permitted`) | The native project was generated before `app.config.js` added the cleartext plugin. Run `npx expo prebuild --clean` |
| Voice button does nothing / "voice module not installed" | Running in Expo Go, or the native build predates `expo-speech-recognition`. Use a dev or release build |
| No push notifications | Running in Expo Go, permission denied, or the push project id does not match your EAS project (see *Push notifications*) |
| Changed `EXPO_PUBLIC_NOSLEEP_URL` but nothing changed | It is inlined at bundle time. Restart Metro with `npx expo start -c`, or rebuild |

## Android beta notes

No screen uses an iOS-only API. The platform differences in the code are:

- `KeyboardAvoidingView` uses `padding` on iOS and no behaviour on Android
  (Launch, Terminal, Brain Search, Brain Capture), so the keyboard may cover
  inputs on some Android devices.
- Monospace text uses `Menlo` on iOS and `monospace` on Android.
- The app icon badge count is only set on iOS.
- Voice uses Android's `SpeechRecognizer`. Whether recognition can run on the
  device depends on the phone's speech services.

## Tests

```bash
cd packages/mobile
npx vitest run           # discovery, config, ws, terminal, app-config
npx tsc --noEmit -p .
```
