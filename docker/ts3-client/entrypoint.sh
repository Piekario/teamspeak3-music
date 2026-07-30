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

# Xvfb refuses to start when a lock file for the display already exists, reporting
# "Server is already active for display 99". Those files live in the container's writable
# layer, so they survive `docker restart` — and with `restart: unless-stopped` that means a
# single restart would leave every bot permanently without a display, and therefore dead.
# Clearing them here makes a restart genuinely idempotent.
DISPLAY_NUMBER="${DISPLAY#:}"
DISPLAY_NUMBER="${DISPLAY_NUMBER%%.*}"
if [[ -e "/tmp/.X${DISPLAY_NUMBER}-lock" || -e "/tmp/.X11-unix/X${DISPLAY_NUMBER}" ]]; then
  log "clearing stale X lock for display :${DISPLAY_NUMBER}"
  rm -f "/tmp/.X${DISPLAY_NUMBER}-lock" "/tmp/.X11-unix/X${DISPLAY_NUMBER}"
fi

# The client blocks on a modal licence dialog on first run, and on a "next generation of
# TeamSpeak" promo after that. Neither can be dismissed from the command line — there is no
# accept-licence flag in the binary — but both are recorded in settings.db, so seeding those
# keys before the client ever starts skips both dialogs entirely.
#
# Determined by accepting once through the GUI and diffing settings.db:
#   General.LastShownLicense = <version>   marks the licence as accepted
#   General.SyncOverviewShown = 1          suppresses the promo window
#
# Without this the client sits behind a dialog forever: the connect URI is consumed at
# startup, so it silently never joins the server.
SETTINGS_DB="${CONFIG_DIR}/settings.db"

seed_settings() {
  sqlite3 "${SETTINGS_DB}" <<'SQL'
CREATE TABLE IF NOT EXISTS General (timestamp INTEGER, key TEXT PRIMARY KEY, value TEXT);
INSERT OR REPLACE INTO General (timestamp, key, value)
  VALUES (strftime('%s','now'), 'LastShownLicense', '99'),
         (strftime('%s','now'), 'LicenseVersion',   '99'),
         (strftime('%s','now'), 'SyncOverviewShown', '1');
SQL
}

has_license_marker() {
  [[ -s "${SETTINGS_DB}" ]] || return 1
  local marker
  marker=$(sqlite3 "${SETTINGS_DB}" \
    "SELECT value FROM General WHERE key='LastShownLicense'" 2>/dev/null) || return 1
  [[ -n "${marker}" ]]
}

if ! has_license_marker; then
  log 'seeding settings.db to skip the licence and promo dialogs'
  seed_settings
  chown ts3:ts3 "${SETTINGS_DB}"
fi

# Audio profile.
#
# The client's shipped defaults are all wrong for a music bot and every one of them is
# audible:
#   vad + voice activation  gates out quiet intros and fades
#   agc                     applies its own dynamic gain, so our volume control goes
#                           non-linear and feels broken
#   denoise                 is tuned for speech and mangles music
#
# These are plain newline-separated key=value blobs in settings.db, so they can be set here
# rather than clicked through a GUI. Note TeamSpeak's own spelling of
# `continous_transmission` — it is missing a `u` and must be matched exactly.
seed_audio_profile() {
  sqlite3 "${SETTINGS_DB}" <<'SQL'
CREATE TABLE IF NOT EXISTS Profiles (timestamp INTEGER, key TEXT PRIMARY KEY, value TEXT);
INSERT OR REPLACE INTO Profiles (timestamp, key, value) VALUES
  (strftime('%s','now'), 'Capture/Default/PreProcessing',
   'vad=false
vad_mode=0
voiceactivation_level=-40
vad_over_ptt=false
denoise=false
agc=false
continous_transmission=true'),
  (strftime('%s','now'), 'Playback/Default',
   'MonoSoundExpansion=2
DeviceDisplayName=
VolumeModifier=0
Mode=
PlaybackMonoOverCenterSpeaker=false
PlayMicClicksOnOwn=false
PlayMicClicksOnOthers=false
Device=
AGC=false
ComfortNoiseVolume=-60
ComfortNoiseEnabled=false');
SQL
}

if [[ "${TS3_SEED_AUDIO_PROFILE:-true}" == "true" ]]; then
  log 'applying music-friendly capture settings (continuous transmission, no AGC/VAD/denoise)'
  seed_audio_profile
  chown ts3:ts3 "${SETTINGS_DB}"
fi

log "starting supervisord (VNC=${ENABLE_VNC:-false})"
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/ts3.conf
