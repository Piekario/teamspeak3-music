/**
 * Domain events let the playback domain announce what happened without knowing who cares.
 * The WebSocket hub, the history writer and the queue snapshotter all subscribe; none of
 * them is referenced by the aggregate that raised the event.
 */
export interface DomainEvent {
  readonly name: string;
  readonly occurredAt: Date;
}

/**
 * Aggregates record events rather than publishing them. The application layer pulls them
 * after a successful transition and hands them to the bus, so an aggregate that fails a
 * business rule never leaks a half-truth to subscribers.
 */
export abstract class AggregateRoot {
  #events: DomainEvent[] = [];

  protected record(event: DomainEvent): void {
    this.#events.push(event);
  }

  pullEvents(): readonly DomainEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }
}
