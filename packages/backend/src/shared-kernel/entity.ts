/**
 * An entity is defined by identity, not by attributes: a track whose title was corrected
 * is still the same queue item. Equality is therefore id equality, deliberately ignoring
 * every other field.
 */
export abstract class Entity<TId extends { equals(other: unknown): boolean } | string> {
  readonly id: TId;

  protected constructor(id: TId) {
    this.id = id;
  }

  equals(other: Entity<TId> | undefined | null): boolean {
    if (other === undefined || other === null) return false;
    if (other.constructor !== this.constructor) return false;
    if (typeof this.id === 'string') return this.id === other.id;
    return this.id.equals(other.id);
  }
}
