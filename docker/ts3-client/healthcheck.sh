#!/usr/bin/env bash
#
# Healthy means all three of: the audio sink exists, the ClientQuery socket answers, and an
# X display is up. The ClientQuery check matters most — the plugin lives inside a GUI
# application and can wedge while the process stays alive, and a failing healthcheck is what
# lets Docker restart it without anyone watching.

set -uo pipefail

fail() { echo "unhealthy: $1" >&2; exit 1; }

pactl list sinks short 2>/dev/null | grep -q "${PULSE_SINK_NAME:-bot_sink}" \
  || fail "PulseAudio sink '${PULSE_SINK_NAME:-bot_sink}' missing"

nc -z 127.0.0.1 25639 \
  || fail "ClientQuery not listening on 25639 (plugin disabled, or client still starting?)"

xdpyinfo -display "${DISPLAY:-:99}" >/dev/null 2>&1 \
  || fail "X display ${DISPLAY:-:99} unavailable"

echo healthy
