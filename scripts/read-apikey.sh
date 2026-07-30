#!/usr/bin/env bash
#
# Reads a bot instance's ClientQuery API key out of its config volume.
#
# The TeamSpeak 3.6.2 client enables the ClientQuery plugin by default and generates this
# key on first start, writing it to clientquery.ini. That makes the key readable without
# ever opening the GUI — which is why the bootstrap below is far shorter than "click through
# Tools -> Options -> Addons" would suggest.
#
# Usage:  scripts/read-apikey.sh <instance-id>
#         scripts/read-apikey.sh party

set -euo pipefail

INSTANCE="${1:-}"
if [[ -z "${INSTANCE}" ]]; then
  echo "usage: $0 <instance-id>" >&2
  exit 1
fi

CONTAINER="tsmusic-client-${INSTANCE}"

if ! docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  echo "no container named '${CONTAINER}'. Start it first:" >&2
  echo "  docker compose -f docker-compose.yml -f docker-compose.instances.yml up -d" >&2
  exit 1
fi

KEY=$(docker exec "${CONTAINER}" sh -c \
  'grep -i "^api_key=" /home/ts3/.ts3client/clientquery.ini 2>/dev/null | cut -d= -f2- | tr -d "\r"' || true)

if [[ -z "${KEY}" ]]; then
  echo "no API key yet — the client may still be starting. Wait for the container to report" >&2
  echo "healthy, then try again:  docker ps --filter name=${CONTAINER}" >&2
  exit 1
fi

echo "${KEY}"
