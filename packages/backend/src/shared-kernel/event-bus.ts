import type { AppEvent, AppEventType } from '@tsmusic/shared';

export type EventHandler<T extends AppEventType> = (
  event: Extract<AppEvent, { type: T }>,
) => void;

export type AnyEventHandler = (event: AppEvent) => void;

export interface EventPublisher {
  publish(event: AppEvent): void;
}

export interface EventSubscriber {
  on<T extends AppEventType>(type: T, handler: EventHandler<T>): Unsubscribe;
  onAny(handler: AnyEventHandler): Unsubscribe;
}

export type Unsubscribe = () => void;

/**
 * A typed in-process pub/sub. Deliberately not Node's EventEmitter: this one is exhaustively
 * typed against the shared event union, so a new event variant is a compile error at every
 * place that must handle it rather than a silently unhandled string.
 *
 * A throwing subscriber must never take down the publisher — one broken WebSocket client
 * cannot be allowed to stop playback — so handlers are isolated and their failures reported
 * through `onHandlerError`.
 */
export class EventBus implements EventPublisher, EventSubscriber {
  readonly #handlers = new Map<AppEventType, Set<AnyEventHandler>>();
  readonly #wildcards = new Set<AnyEventHandler>();
  readonly #onHandlerError: (error: unknown, event: AppEvent) => void;

  constructor(onHandlerError: (error: unknown, event: AppEvent) => void) {
    this.#onHandlerError = onHandlerError;
  }

  publish(event: AppEvent): void {
    for (const handler of this.#handlers.get(event.type) ?? []) {
      this.#invoke(handler, event);
    }
    for (const handler of this.#wildcards) {
      this.#invoke(handler, event);
    }
  }

  on<T extends AppEventType>(type: T, handler: EventHandler<T>): Unsubscribe {
    const handlers = this.#handlers.get(type) ?? new Set<AnyEventHandler>();
    handlers.add(handler as AnyEventHandler);
    this.#handlers.set(type, handlers);
    return () => {
      handlers.delete(handler as AnyEventHandler);
    };
  }

  onAny(handler: AnyEventHandler): Unsubscribe {
    this.#wildcards.add(handler);
    return () => {
      this.#wildcards.delete(handler);
    };
  }

  #invoke(handler: AnyEventHandler, event: AppEvent): void {
    try {
      handler(event);
    } catch (error) {
      this.#onHandlerError(error, event);
    }
  }
}
