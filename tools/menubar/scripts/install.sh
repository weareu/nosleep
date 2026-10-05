#!/usr/bin/env bash
#
# Build the NoSleepStatus menu bar app, package it as a proper
# .app bundle in ~/Applications, self-sign it (ad-hoc), and install
# a LaunchAgent that opens it at login + on-demand.
#
# Re-run any time the Swift source changes — the script overwrites
# the existing bundle in place and re-loads the LaunchAgent.
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="NoSleepStatus"
APP_DIR="${HOME}/Applications/${APP_NAME}.app"
LAUNCH_AGENT_LABEL="com.nosleep.menubar"
LAUNCH_AGENT_PATH="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"

cd "${HERE}"

echo "==> Building Swift binary (release)…"
swift build -c release --product "${APP_NAME}"

BIN="${HERE}/.build/release/${APP_NAME}"
if [ ! -x "${BIN}" ]; then
  echo "FAIL: built binary not found at ${BIN}"
  exit 1
fi

echo "==> Packaging .app bundle at ${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS"
mkdir -p "${APP_DIR}/Contents/Resources"
cp "${BIN}" "${APP_DIR}/Contents/MacOS/${APP_NAME}"
chmod +x "${APP_DIR}/Contents/MacOS/${APP_NAME}"

cat >"${APP_DIR}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>NoSleep Status</string>
  <key>CFBundleIdentifier</key><string>com.nosleep.menubar</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

echo "==> Ad-hoc signing"
codesign --force --deep --sign - "${APP_DIR}"
codesign --verify --deep --strict "${APP_DIR}"

echo "==> Writing LaunchAgent ${LAUNCH_AGENT_PATH}"
cat >"${LAUNCH_AGENT_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${APP_DIR}/Contents/MacOS/${APP_NAME}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${HOME}/Library/Logs/nosleep-menubar.log</string>
  <key>StandardErrorPath</key><string>${HOME}/Library/Logs/nosleep-menubar.log</string>
</dict>
</plist>
PLIST

echo "==> Reloading LaunchAgent"
launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${LAUNCH_AGENT_PATH}"

echo "==> Done."
echo "Menu bar icon should appear within a second or two."
echo "Logs: ${HOME}/Library/Logs/nosleep-menubar.log"
