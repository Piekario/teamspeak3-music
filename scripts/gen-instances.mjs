#!/usr/bin/env node
/**
 * Generates `docker-compose.instances.yml` from `instances.json`.
 *
 * Each bot needs its own headless TeamSpeak client container, and Compose has no way to
 * express "one service per entry in a config file". Generating the file keeps the list of
 * bots in one human-edited place instead of copy-pasted service blocks that drift apart.
 *
 * The generated file is disposable and gitignored — regenerate rather than edit it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = resolve(projectRoot, 'instances.json');
const outputPath = resolve(projectRoot, 'docker-compose.instances.yml');

/** VNC is exposed per instance, one port each, because bootstrap is a per-client ritual. */
const VNC_BASE_PORT = 5900;

function fail(message) {
  console.error(`gen-instances: ${message}`);
  process.exit(1);
}

function readInstances() {
  let raw;
  try {
    raw = readFileSync(inputPath, 'utf8');
  } catch {
    fail(`cannot read ${inputPath}. Copy instances.example.json to instances.json first.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`instances.json is not valid JSON: ${error.message}`);
  }

  const instances = parsed.instances;
  if (!Array.isArray(instances) || instances.length === 0) {
    fail('instances.json must contain a non-empty "instances" array.');
  }
  return instances;
}

function validate(instances) {
  const seen = new Set();

  for (const instance of instances) {
    const id = instance.id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      fail(`instance id ${JSON.stringify(id)} must be lowercase letters, digits and dashes.`);
    }
    if (seen.has(id)) fail(`duplicate instance id "${id}".`);
    seen.add(id);

    if (typeof instance.teamspeak?.host !== 'string' || instance.teamspeak.host.length === 0) {
      fail(`instance "${id}" is missing teamspeak.host.`);
    }
    // An empty API key produces a container that starts and then silently answers nothing,
    // which is a far more confusing failure than refusing to generate.
    if (typeof instance.clientQuery?.apiKey !== 'string' || instance.clientQuery.apiKey.length === 0) {
      fail(`instance "${id}" is missing clientQuery.apiKey — run the VNC bootstrap first.`);
    }
  }
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function renderService(instance, index) {
  const id = instance.id;
  const ts = instance.teamspeak;
  const enabled = instance.enabled !== false;

  const environment = [
    ['TS3_SERVER_HOST', ts.host],
    ['TS3_SERVER_PORT', ts.port ?? 9987],
    ['TS3_NICKNAME', ts.nickname ?? `MusicBot-${id}`],
    ['PULSE_SINK_NAME', 'bot_sink'],
    ['PULSE_SOURCE_NAME', 'bot_mic'],
    ['ENABLE_VNC', String(instance.enableVnc ?? false)],
  ];
  if (ts.channel) environment.push(['TS3_CHANNEL', ts.channel]);
  if (instance.serverPassword) environment.push(['TS3_SERVER_PASSWORD', instance.serverPassword]);
  if (ts.channelPassword) environment.push(['TS3_CHANNEL_PASSWORD', ts.channelPassword]);

  const environmentLines = environment
    .map(([key, value]) => `      ${key}: ${quote(value)}`)
    .join('\n');

  // VNC is published only when explicitly enabled: the port has no authentication and
  // exposes a live view of a logged-in TeamSpeak client.
  const vncPort = instance.enableVnc
    ? `\n    ports:\n      - "127.0.0.1:${VNC_BASE_PORT + index}:5900"`
    : '';

  return `  ts3-client-${id}:
    build:
      context: ./docker/ts3-client
    image: tsmusic/ts3-client:3.6.2
    platform: linux/amd64
    container_name: tsmusic-client-${id}
    restart: ${enabled ? 'unless-stopped' : 'no'}
    environment:
${environmentLines}
      DISPLAY: ":99"
    volumes:
      # The identity, the ClientQuery API key and every audio setting live here. This volume
      # is the only state in the project that cannot be rebuilt — back it up.
      - ts3-config-${id}:/home/ts3/.ts3client
    expose:
      - "25639"
      - "4713"${vncPort}
    networks:
      - tsmusic
`;
}

function render(instances) {
  const services = instances.map(renderService).join('\n');
  const volumes = instances.map((instance) => `  ts3-config-${instance.id}: {}`).join('\n');
  const summary = instances
    .map((i) => `#   ${i.id.padEnd(12)} -> ${i.teamspeak.host}:${i.teamspeak.port ?? 9987}`)
    .join('\n');

  return `# GENERATED FILE — do not edit.
# Regenerate with: pnpm instances:generate
#
# Bots defined here:
${summary}

services:
${services}
volumes:
${volumes}

networks:
  tsmusic:
    external: false
`;
}

const instances = readInstances();
validate(instances);
writeFileSync(outputPath, render(instances), 'utf8');

console.log(`gen-instances: wrote ${outputPath}`);
for (const instance of instances) {
  const state = instance.enabled === false ? ' (disabled)' : '';
  console.log(`  - ${instance.id} -> ${instance.teamspeak.host}${state}`);
}
console.log('\nNext: docker compose -f docker-compose.yml -f docker-compose.instances.yml up -d');
