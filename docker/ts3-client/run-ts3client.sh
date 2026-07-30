#!/usr/bin/env bash
#
# Launches the TeamSpeak client once its dependencies are actually ready.
#
# supervisord starts programs in priority order but does not wait for readiness, and a Qt
# application that opens before Xvfb is listening dies in a way that looks like a missing
# plugin. Waiting explicitly here turns a confusing crash loop into a boring startup.

set -euo pipefail

TS3_DIR="/opt/ts3client"
CONFIG_DIR="${HOME}/.ts3client"

log() { printf '[ts3client] %s\n' "$*"; }

wait_for() {
  local description="$1" attempts="$2"
  shift 2
  for ((i = 1; i <= attempts; i++)); do
    if "$@" >/dev/null 2>&1; then
      log "${description}: ready"
      return 0
    fi
    sleep 1
  done
  log "${description}: NOT ready after ${attempts}s — starting anyway"
  return 1
}

wait_for "X display ${DISPLAY}" 30 xdpyinfo -display "${DISPLAY}" || true
wait_for "PulseAudio sink ${PULSE_SINK_NAME:-bot_sink}" 30 \
  bash -c "pactl list sinks short | grep -q '${PULSE_SINK_NAME:-bot_sink}'" || true

mkdir -p "${CONFIG_DIR}"

# The client refuses to start until its licence has been accepted. Accepting it here is the
# same act as ticking the box in the installer; the file is what the client itself writes.
if [[ ! -f "${CONFIG_DIR}/.ts3client_accepted_license" ]]; then
  log "accepting client licence"
  : > "${CONFIG_DIR}/.ts3client_accepted_license"
fi

# A connect URI makes the client join on its own, so no automation has to drive the GUI.
# Identity, capture device and the ClientQuery API key still come from the persisted
# settings.db created during the one-time VNC bootstrap — see README.
CONNECT_ARGS=()
if [[ -n "${TS3_SERVER_HOST:-}" ]]; then
  uri="ts3server://${TS3_SERVER_HOST}?port=${TS3_SERVER_PORT:-9987}"
  [[ -n "${TS3_NICKNAME:-}" ]] && uri+="&nickname=$(printf '%s' "${TS3_NICKNAME}" | sed 's/ /%20/g')"
  [[ -n "${TS3_SERVER_PASSWORD:-}" ]] && uri+="&password=${TS3_SERVER_PASSWORD}"
  [[ -n "${TS3_CHANNEL:-}" ]] && uri+="&channel=$(printf '%s' "${TS3_CHANNEL}" | sed 's/ /%20/g')"
  [[ -n "${TS3_CHANNEL_PASSWORD:-}" ]] && uri+="&channelpassword=${TS3_CHANNEL_PASSWORD}"
  CONNECT_ARGS+=("${uri}")
  log "connect URI: ts3server://${TS3_SERVER_HOST}?port=${TS3_SERVER_PORT:-9987} (credentials redacted)"
else
  log "no TS3_SERVER_HOST set — starting client without auto-connect"
fi

cd "${TS3_DIR}"
log "starting TeamSpeak client"
exec ./ts3client_runscript.sh -nosingleinstance "${CONNECT_ARGS[@]}"
