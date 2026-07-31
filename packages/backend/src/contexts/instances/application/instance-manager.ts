import type { InstanceSummary } from '@tsmusic/shared';

import { err, ok, type Result } from '../../../shared-kernel/result.ts';
import type { InstanceConfig } from '../domain/instance.ts';
import { InstanceRuntime, type InstanceRuntimeDependencies } from './instance-runtime.ts';

export type InstanceLookupError = { readonly kind: 'instance/not-found'; readonly id: string };
export type InstanceCreateError = { readonly kind: 'instance/duplicate-id'; readonly id: string };

/** Everything a runtime needs except the instance-specific configuration. */
export type RuntimeFactoryDependencies = Omit<InstanceRuntimeDependencies, 'config'>;

export type InstanceRuntimeFactory = (config: InstanceConfig) => InstanceRuntime;

/**
 * Owns every bot instance and is the only way the rest of the application reaches one.
 *
 * The point of routing everything through here is that a bot is never a global: an HTTP
 * request, a WebSocket subscription and a chat command all address a specific instance by
 * id, and an id that does not exist is an ordinary error rather than a crash. Adding a
 * second bot on a second TeamSpeak server touches no code — only configuration.
 */
export class InstanceManager {
  readonly #runtimes = new Map<string, InstanceRuntime>();
  readonly #factory: InstanceRuntimeFactory;

  constructor(factory: InstanceRuntimeFactory) {
    this.#factory = factory;
  }

  /** Builds a runtime from `deps` plus per-instance config — the usual composition root. */
  static withDependencies(deps: RuntimeFactoryDependencies): InstanceManager {
    return new InstanceManager((config) => new InstanceRuntime({ ...deps, config }));
  }

  get ids(): readonly string[] {
    return [...this.#runtimes.keys()];
  }

  get all(): readonly InstanceRuntime[] {
    return [...this.#runtimes.values()];
  }

  has(id: string): boolean {
    return this.#runtimes.has(id);
  }

  get(id: string): Result<InstanceRuntime, InstanceLookupError> {
    const runtime = this.#runtimes.get(id);
    return runtime === undefined ? err({ kind: 'instance/not-found', id }) : ok(runtime);
  }

  add(config: InstanceConfig): Result<InstanceRuntime, InstanceCreateError> {
    if (this.#runtimes.has(config.id)) {
      return err({ kind: 'instance/duplicate-id', id: config.id });
    }

    const runtime = this.#factory(config);
    this.#runtimes.set(config.id, runtime);
    return ok(runtime);
  }

  async remove(id: string): Promise<Result<void, InstanceLookupError>> {
    const runtime = this.#runtimes.get(id);
    if (runtime === undefined) return err({ kind: 'instance/not-found', id });

    this.#runtimes.delete(id);
    await runtime.stop();
    return ok();
  }

  /**
   * Applies new configuration, restarting the instance only when the change demands it.
   * Adjusting a queue limit should not interrupt whatever is playing.
   */
  async reconfigure(config: InstanceConfig): Promise<Result<void, InstanceLookupError>> {
    const runtime = this.#runtimes.get(config.id);
    if (runtime === undefined) return err({ kind: 'instance/not-found', id: config.id });

    const { requiresRestart } = runtime.applyConfig(config);
    if (requiresRestart) {
      await runtime.stop();
      runtime.start();
    }
    return ok();
  }

  startAll(): void {
    for (const runtime of this.#runtimes.values()) runtime.start();
  }

  /**
   * Stops every instance concurrently. One instance failing to shut down cleanly must not
   * prevent the others from stopping, so failures are contained per runtime.
   */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.#runtimes.values()].map((runtime) => runtime.stop()));
  }

  summaries(): readonly InstanceSummary[] {
    return this.all.map((runtime) => ({
      id: runtime.id,
      name: runtime.config.name,
      enabled: runtime.config.enabled,
      // Built field by field rather than passed through. The narrower type alone would not
      // help: TypeScript permits assigning a wider object to it, so the channel password
      // would still be serialised to every panel.
      teamspeak: {
        host: runtime.config.teamspeak.host,
        port: runtime.config.teamspeak.port,
        nickname: runtime.config.teamspeak.nickname,
        channel: runtime.config.teamspeak.channel,
        homeChannelId: runtime.config.teamspeak.homeChannelId,
      },
      connection: runtime.connectionState,
      connectionError: null,
      currentChannel: null,
    }));
  }
}
