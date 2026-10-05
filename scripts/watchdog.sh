#!/usr/bin/env bash
#
# NoSleep watchdog — probes /health, kicks the LaunchAgent on two
# consecutive failures. Designed to run from launchd every 30s.
#
# Why four strikes: the server legitimately blocks the event loop for
# ~20-30s during startup (brain model bootstrap, first ONNX session load).
# A 2-strike / 60s window killed it mid-bootstrap before it could ever
# stabilize, producing a kill→restart→re-bootstrap loop (398 kicks in one
# incident, 2026-06-14). Four consecutive failures across 30s windows = ~2
# minutes of being unreachable, which is a true wedge, not slow startup.
#
# State lives in /tmp so a reboot resets it cleanly. The kick uses
# `launchctl kickstart -k` which sends SIGTERM and re-spawns — same as
# a manual restart.
#
set -u

PORT="${NOSLEEP_PORT:-3777}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
LABEL="com.nosleep.server"
STATE_FILE="/tmp/nosleep-watchdog.miss"
TIMEOUT=8
STRIKE_LIMIT=4
LOG_PREFIX="[$(date '+%Y-%m-%dT%H:%M:%S%z') watchdog]"

probe_ok() {
  curl -fsS --max-time "${TIMEOUT}" -o /dev/null "${HEALTH_URL}"
}

reset_strike() {
  rm -f "${STATE_FILE}"
}

increment_strike() {
  local n
  n=$(cat "${STATE_FILE}" 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "${n}" > "${STATE_FILE}"
  echo "${n}"
}

if probe_ok; then
  reset_strike
  exit 0
fi

# Probe failed. Count the strike and decide whether to kick.
STRIKES=$(increment_strike)
echo "${LOG_PREFIX} probe failed (strike ${STRIKES}) — ${HEALTH_URL}"

if [ "${STRIKES}" -ge "${STRIKE_LIMIT}" ]; then
  echo "${LOG_PREFIX} ${STRIKES} consecutive failures — kicking ${LABEL}"
  launchctl kickstart -k "gui/$(id -u)/${LABEL}"
  reset_strike
  # Give it a moment, then verify the kick produced a healthy server.
  sleep 6
  if probe_ok; then
    echo "${LOG_PREFIX} kick recovered server"
  else
    echo "${LOG_PREFIX} WARNING: server still unresponsive after kick"
  fi
fi

# Trim logs that grew too large. Keeps the tail. The server logs grow without
# bound (launchd just appends to StandardOutPath/StandardErrorPath); one
# incident left them at 116MB + 60MB. These are truncated IN PLACE (cp tail
# then ': >') so launchd's open file descriptor keeps writing to the same inode.
trim_log() {
  local file="$1" max="$2" keep="$3"
  [ -f "${file}" ] || return 0
  local size
  size=$(stat -f%z "${file}" 2>/dev/null || echo 0)
  if [ "${size}" -gt "${max}" ]; then
    tail -c "${keep}" "${file}" > "${file}.tmp" 2>/dev/null && cat "${file}.tmp" > "${file}" && rm -f "${file}.tmp"
  fi
}

trim_log "${HOME}/Library/Logs/nosleep-watchdog.log" 5242880 1048576   # 5MB → 1MB
trim_log "${HOME}/.nosleep/server.log" 52428800 8388608                 # 50MB → 8MB
trim_log "${HOME}/.nosleep/server.err" 52428800 8388608                 # 50MB → 8MB
