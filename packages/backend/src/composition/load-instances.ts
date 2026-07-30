import { readFileSync } from 'node:fs';

import { createInstanceConfig, type InstanceConfig } from '../contexts/instances/domain/instance.ts';
import { err, ok, type Result } from '../shared-kernel/result.ts';

export type InstanceFileError =
  | { readonly kind: 'instances/unreadable'; readonly path: string; readonly detail: string }
  | { readonly kind: 'instances/invalid-json'; readonly detail: string }
  | { readonly kind: 'instances/empty' }
  | { readonly kind: 'instances/invalid-entry'; readonly id: string; readonly detail: string };

interface RawInstance {
  readonly id: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly teamspeak: {
    readonly host: string;
    readonly port?: number;
    readonly nickname?: string;
    readonly homeChannelId?: number | null;
  };
  readonly serverPassword?: string | null;
  readonly clientQuery: { readonly host?: string; readonly port?: number; readonly apiKey: string };
  readonly audio?: { readonly pulseServer?: string; readonly sinkName?: string };
  readonly playback?: Record<string, unknown>;
  readonly commands?: Record<string, unknown>;
  readonly permissions?: Record<string, unknown>;
}

/**
 * Reads the bot list.
 *
 * The container names in the generated compose file are derived from the instance id, so the
 * ClientQuery host and PulseAudio address can be defaulted from that same id. Stating them
 * per instance is possible — and is what makes running a client container on a different
 * host a configuration change rather than a code change — but nobody should have to.
 */
export function loadInstanceConfigs(path: string): Result<readonly InstanceConfig[], InstanceFileError> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return err({
      kind: 'instances/unreadable',
      path,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  let parsed: { instances?: readonly RawInstance[] };
  try {
    parsed = JSON.parse(raw) as { instances?: readonly RawInstance[] };
  } catch (error) {
    return err({
      kind: 'instances/invalid-json',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const entries = parsed.instances ?? [];
  if (entries.length === 0) return err({ kind: 'instances/empty' });

  const configs: InstanceConfig[] = [];
  for (const entry of entries) {
    const created = createInstanceConfig({
      id: entry.id,
      name: entry.name ?? entry.id,
      ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
      teamspeak: entry.teamspeak,
      serverPassword: entry.serverPassword ?? null,
      clientQuery: {
        host: entry.clientQuery?.host ?? `tsmusic-client-${entry.id}`,
        ...(entry.clientQuery?.port !== undefined ? { port: entry.clientQuery.port } : {}),
        apiKey: entry.clientQuery?.apiKey,
      },
      audio: {
        pulseServer: entry.audio?.pulseServer ?? `tcp:tsmusic-client-${entry.id}:4713`,
        ...(entry.audio?.sinkName !== undefined ? { sinkName: entry.audio.sinkName } : {}),
      },
      ...(entry.playback !== undefined ? { playback: entry.playback } : {}),
      ...(entry.commands !== undefined ? { commands: entry.commands } : {}),
      ...(entry.permissions !== undefined ? { permissions: entry.permissions } : {}),
    });

    if (!created.ok) {
      const detail =
        created.error.kind === 'instance/missing-field'
          ? `missing ${created.error.field}`
          : `invalid ${created.error.field} (${created.error.value})`;
      return err({ kind: 'instances/invalid-entry', id: entry.id ?? '(no id)', detail });
    }

    configs.push(created.value);
  }

  return ok(configs);
}

export function describeInstanceFileError(error: InstanceFileError): string {
  switch (error.kind) {
    case 'instances/unreadable':
      return `cannot read ${error.path}: ${error.detail}. Copy instances.example.json to instances.json.`;
    case 'instances/invalid-json':
      return `instances file is not valid JSON: ${error.detail}`;
    case 'instances/empty':
      return 'instances file contains no instances';
    case 'instances/invalid-entry':
      return `instance "${error.id}": ${error.detail}`;
  }
}
