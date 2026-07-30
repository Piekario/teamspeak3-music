#!/usr/bin/env bash
#
# Container entrypoint: prepares the runtime directories PulseAudio's system mode expects,
# then hands over to supervisord which owns every long-running process.

set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*"; }

CONFIG_DIR="/home/ts3/.ts3client"

# The config directory is a named volume and the single most valuable piece of state in the
# whole project: it holds the client identity, the ClientQuery API key and every audio
# setting chosen during the VNC bootstrap. Losing it means redoing that bootstrap by hand.
mkdir -p "${CONFIG_DIR}"
chown -R ts3:ts3 /home/ts3

mkdir -p /run/pulse /var/lib/pulse /run/dbus
chown -R pulse:pulse /run/pulse /var/lib/pulse

if [[ ! -s "${CONFIG_DIR}/settings.db" ]]; then
  log ''
  log '*** No settings.db found — this client has not been bootstrapped yet. ***'
  log 'It will start, but it has no identity, no capture device and no ClientQuery API key.'
  log 'Run the one-time GUI bootstrap over VNC (ENABLE_VNC=true, then connect to :5900).'
  log 'See README.md, section "One-time client bootstrap".'
  log ''
fi

log "starting supervisord (VNC=${ENABLE_VNC:-false})"
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/ts3.conf
