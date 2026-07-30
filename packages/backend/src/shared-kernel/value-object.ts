/**
 * A value object has no identity: two instances holding the same value are the same thing.
 * Subclasses are immutable and validate in a static factory returning `Result`, so an
 * instance that exists is an instance that is valid — no defensive re-checking downstream.
 */
export abstract class ValueObject<T> {
  readonly value: T;

  protected constructor(value: T) {
    this.value = value;
    Object.freeze(this);
  }

  equals(other: ValueObject<T> | undefined | null): boolean {
    if (other === undefined || other === null) return false;
    if (other.constructor !== this.constructor) return false;
    return this.value === other.value;
  }

  toString(): string {
    return String(this.value);
  }

  toJSON(): T {
    return this.value;
  }
}
