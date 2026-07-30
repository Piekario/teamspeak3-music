import type { AppEvent } from '@tsmusic/shared';

import type { EventSubscriber, Unsubscribe } from '../../shared-kernel/event-bus.ts';
import type { ScopedLogger } from '../logging/logger.ts';

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

const OPEN = 1;

/**
 * Fans domain events out to connected browsers.
 *
 * The socket is strictly server-to-client: every mutation goes through REST, so there is
 * exactly one write path and the socket stays a pure read model. That is a deliberate
 * simplification — bidirectional RPC over a socket would duplicate authorisation and make
 * "who changed this" much harder to reason about.
 *
 * Events carry their `instanceId`, and one socket multiplexes every bot. The panel's
 * instance switcher is then a filter over an existing stream rather than a reconnect.
 */
export class WebSocketHub {
  readonly #clients = new Set<WebSocketLike>();
  readonly #logger: ScopedLogger;
  #unsubscribe: Unsubscribe | undefined;

  constructor(logger: ScopedLogger) {
    this.#logger = logger;
  }

  /** Starts forwarding bus events. Returns a function that stops forwarding. */
  attach(events: EventSubscriber): Unsubscribe {
    this.#unsubscribe?.();
    this.#unsubscribe = events.onAny((event) => this.broadcast(event));
    return () => {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
    };
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  add(socket: WebSocketLike): void {
    this.#clients.add(socket);
  }

  remove(socket: WebSocketLike): void {
    this.#clients.delete(socket);
  }

  /**
   * Sends to every open client. A socket that fails to accept a write is dropped rather
   * than retried: one wedged browser tab must never slow down playback, and the client
   * reconnects and resynchronises on its own.
   */
  broadcast(event: AppEvent): void {
    if (this.#clients.size === 0) return;

    const payload = JSON.stringify(event);
    for (const client of this.#clients) {
      if (client.readyState !== OPEN) {
        this.#clients.delete(client);
        continue;
      }
      try {
        client.send(payload);
      } catch (error) {
        this.#logger.debug('dropping unwritable websocket client', {
          reason: error instanceof Error ? error.message : String(error),
        });
        this.#clients.delete(client);
      }
    }
  }

  /** Sends a snapshot to one client — used on connect so the UI never renders an empty shell. */
  sendTo(socket: WebSocketLike, events: readonly AppEvent[]): void {
    for (const event of events) {
      if (socket.readyState !== OPEN) return;
      try {
        socket.send(JSON.stringify(event));
      } catch {
        this.#clients.delete(socket);
        return;
      }
    }
  }

  closeAll(): void {
    for (const client of this.#clients) {
      try {
        client.close(1001, 'server shutting down');
      } catch {
        // Already gone; nothing useful to do.
      }
    }
    this.#clients.clear();
  }
}
