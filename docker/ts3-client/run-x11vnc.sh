#!/usr/bin/env bash
#
# VNC is the escape hatch for everything the TeamSpeak client will not let us configure
# headlessly: accepting the privacy dialog, creating an identity, choosing the capture
# device, disabling the microphone processing that fights our volume control, and enabling
# the ClientQuery plugin to read its API key.
#
# It is off by default because it exposes an unauthenticated view of the client's GUI.

set -euo pipefail

if [[ "${ENABLE_VNC:-false}" != "true" ]]; then
  echo '[x11vnc] disabled (set ENABLE_VNC=true to enable)'
  # supervisord restarts a program that exits; sleeping keeps it nominally "running"
  # without burning CPU or spamming the log.
  exec sleep infinity
fi

# x11vnc dies immediately if the display is not up yet, and supervisord's retry budget is
# quickly exhausted by that — leaving no VNC for the rest of the container's life, which is
# precisely when it is needed. Waiting first keeps the retry budget for real failures.
for _ in $(seq 1 60); do
  if xdpyinfo -display "${DISPLAY:-:99}" >/dev/null 2>&1; then break; fi
  sleep 1
done

echo '[x11vnc] starting on :5900 — bind it to localhost only, it has no authentication'
exec x11vnc -display "${DISPLAY:-:99}" -forever -shared -nopw -rfbport 5900 -quiet -noxdamage
